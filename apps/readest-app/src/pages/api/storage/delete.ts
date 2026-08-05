import { and, eq } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { deleteObject } from '@/utils/object';

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

      const { fileKey } = req.query;

      if (!fileKey || typeof fileKey !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid fileKey' });
      }

      // Scoped by user_id, so someone else's file_key reads as 404 rather than
      // 403 — the caller learns nothing about what other users hold (ADR-005).
      const [fileRecord] = await db
        .select({ id: schema.files.id })
        .from(schema.files)
        .where(and(eq(schema.files.userId, user.id), eq(schema.files.fileKey, fileKey)))
        .limit(1);

      if (!fileRecord) {
        return res.status(404).json({ error: 'File not found' });
      }

      try {
        await deleteObject(fileKey);
      } catch (error) {
        console.error('Error deleting file from storage:', error);
        return res.status(500).json({ error: 'Could not delete file from storage' });
      }

      try {
        await db.delete(schema.files).where(eq(schema.files.id, fileRecord.id));
      } catch (error) {
        // Bytes are gone but the row is not: the file will read as present and
        // 404 on download until this is retried.
        console.error('Error deleting file record:', error);
        return res.status(500).json({ error: 'Could not update file record' });
      }

      return res.status(200).json({ message: 'File deleted successfully' });
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
