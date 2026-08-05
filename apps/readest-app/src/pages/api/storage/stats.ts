import { and, count, desc, eq, isNull, sql, sum } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { getStoragePlanData } from '@/utils/access';
import { corsAllMethods, runMiddleware } from '@/utils/cors';

interface StorageStats {
  totalFiles: number;
  totalSize: number;
  usage: number;
  quota: number;
  usagePercentage: number;
  byBookHash: Array<{
    bookHash: string | null;
    fileCount: number;
    totalSize: number;
  }>;
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    return await withDb(async (db) => {
      const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
      if (!user || !token) {
        return res.status(403).json({ error: 'Not authenticated' });
      }

      const live = and(eq(schema.files.userId, user.id), isNull(schema.files.deletedAt));

      // Both of these used to be page-by-page loops over every row the user
      // owns, because PostgREST caps a response at 1000 rows and the totals
      // were summed in JavaScript. The grouping additionally called
      // `get_storage_by_book_hash`, an RPC that exists in no migration, and
      // fell back to a second full scan when it failed — which was always.
      let totals: { files: number; size: string | null } | undefined;
      let byBookHash: StorageStats['byBookHash'];
      try {
        [totals] = await db
          .select({ files: count(), size: sum(schema.files.fileSize) })
          .from(schema.files)
          .where(live);

        const grouped = await db
          .select({
            bookHash: schema.files.bookHash,
            fileCount: count(),
            totalSize: sum(schema.files.fileSize).mapWith(Number),
          })
          .from(schema.files)
          .where(live)
          .groupBy(schema.files.bookHash)
          .orderBy(desc(sql`sum(${schema.files.fileSize})`));

        byBookHash = grouped.map((row) => ({
          bookHash: row.bookHash,
          fileCount: row.fileCount,
          totalSize: row.totalSize ?? 0,
        }));
      } catch (error) {
        console.error('Error querying storage statistics:', error);
        return res.status(500).json({ error: 'Failed to retrieve storage statistics' });
      }

      const { usage, quota } = getStoragePlanData(token);
      const response: StorageStats = {
        totalFiles: totals?.files ?? 0,
        // `sum` comes back as a numeric string, or null for an empty set.
        totalSize: Number(totals?.size ?? 0),
        usage,
        quota,
        usagePercentage: quota > 0 ? Math.round((usage / quota) * 100) : 0,
        byBookHash,
      };

      return res.status(200).json(response);
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}
