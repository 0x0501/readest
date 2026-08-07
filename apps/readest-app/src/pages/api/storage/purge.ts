import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { deleteObject } from '@/utils/object';
import { clientSafeMessage } from '@/libs/errors';

interface BulkDeleteResult {
  success: string[];
  failed: Array<{ fileKey: string; error: string }>;
  deletedCount: number;
  failedCount: number;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    return await withDb(async (db) => {
      const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
      if (!user || !token) {
        return res.status(403).json({ error: 'Not authenticated' });
      }

      const { fileKeys } = req.body;

      if (!fileKeys || !Array.isArray(fileKeys)) {
        return res.status(400).json({ error: 'Missing or invalid fileKeys array' });
      }

      if (fileKeys.length === 0) {
        return res.status(400).json({ error: 'fileKeys array cannot be empty' });
      }

      if (fileKeys.length > 100) {
        return res.status(400).json({ error: 'Cannot delete more than 100 files at once' });
      }

      if (!fileKeys.every((key) => typeof key === 'string')) {
        return res.status(400).json({ error: 'All fileKeys must be strings' });
      }

      // Scoped to the caller, so a key belonging to someone else simply does not
      // come back and lands in `failed` as "not found" below (ADR-005).
      let fileRecords: { id: string; fileKey: string }[];
      try {
        fileRecords = await db
          .select({ id: schema.files.id, fileKey: schema.files.fileKey })
          .from(schema.files)
          .where(
            and(
              eq(schema.files.userId, user.id),
              inArray(schema.files.fileKey, fileKeys),
              isNull(schema.files.deletedAt),
            ),
          );
      } catch (error) {
        console.error('Error querying files:', error);
        return res.status(500).json({ error: 'Failed to retrieve files for deletion' });
      }

      if (fileRecords.length === 0) {
        return res.status(404).json({ error: 'No matching files found' });
      }

      // Process deletions
      const results = await Promise.allSettled(
        fileRecords.map(async (fileRecord) => {
          try {
            // Delete from storage
            await deleteObject(fileRecord.fileKey);
            await db.delete(schema.files).where(eq(schema.files.id, fileRecord.id));

            return { fileKey: fileRecord.fileKey, success: true };
          } catch (error) {
            console.error(`Error deleting file ${fileRecord.fileKey}:`, error);
            return {
              fileKey: fileRecord.fileKey,
              success: false,
              error: clientSafeMessage(error, 'Unknown error'),
            };
          }
        }),
      );

      const success: string[] = [];
      const failed: Array<{ fileKey: string; error: string }> = [];

      results.forEach((result) => {
        if (result.status === 'fulfilled') {
          if (result.value.success) {
            success.push(result.value.fileKey);
          } else {
            failed.push({
              fileKey: result.value.fileKey,
              error: result.value.error || 'Unknown error',
            });
          }
        } else {
          failed.push({
            fileKey: 'unknown',
            error: result.reason?.message || 'Promise rejected',
          });
        }
      });

      // Handle files that weren't found in the database
      const foundFileKeys = new Set(fileRecords.map((record) => record.fileKey));
      const notFoundKeys = fileKeys.filter((key) => !foundFileKeys.has(key));
      notFoundKeys.forEach((key) => {
        failed.push({
          fileKey: key,
          error: 'File not found or already deleted',
        });
      });

      const response: BulkDeleteResult = {
        success,
        failed,
        deletedCount: success.length,
        failedCount: failed.length,
      };

      // Return 207 Multi-Status if there are partial failures
      const statusCode =
        failed.length > 0 && success.length > 0 ? 207 : failed.length > 0 ? 500 : 200;

      return res.status(statusCode).json(response);
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
