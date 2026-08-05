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

      // GoTrue's admin API is gone; the row in `public."user"` is the account.
      // Deleting it cascades through every `user_id` foreign key — books,
      // notes, configs, shares, files, replicas, the inbox — because
      // `local_002_repoint_user_fks.sql` moved all twelve onto this table with
      // their ON DELETE CASCADE intact.
      //
      // The R2 objects those `files` rows pointed at are NOT removed here, and
      // were not before either: storage cleanup is the purge endpoint's job.
      await db.delete(schema.user).where(eq(schema.user.id, user.id));

      return res.status(200).json({ message: 'User deleted successfully' });
    });
  } catch (error) {
    console.error('User deletion failed:', error);
    return res.status(500).json({ error: 'Could not delete the account' });
  }
}
