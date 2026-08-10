import { eq } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { corsAllMethods, runMiddleware } from '@/utils/cors';

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

      // Hard delete rather than a `deleted_at` tombstone: a tombstone would pull
      // down to every other signed-in device and clear its local library too.
      // `book_configs` / `book_notes` / `files` key off the user row, not
      // `books`, so nothing here cascades — their rows are left behind, keyed by
      // `book_hash`, and line up again if the same book is ever re-added.
      await db.delete(schema.books).where(eq(schema.books.userId, user.id));

      return res.status(200).json({ message: 'Cloud library deleted successfully' });
    });
  } catch (error) {
    console.error('Cloud library deletion failed:', error);
    return res.status(500).json({ error: 'Could not delete the cloud library' });
  }
}
