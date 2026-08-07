import { sql } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { withDb } from '@/libs/db';
import { withUserContext } from '@/libs/db/rpc';
import type { DBSendInboxItem } from '@/types/sendRecords';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { clientSafeMessage } from '@/libs/errors';

/**
 * Claim the oldest drainable inbox item for the caller, via the
 * `claim_inbox_item` RPC. The RPC self-scopes to `auth.uid()`, so the call runs
 * inside `withUserContext`, which sets the subject claim for the transaction —
 * PostgREST used to copy it out of the JWT.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
    if (!user || !token) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    const device = String(req.body?.device ?? '').slice(0, 100);
    if (!device) {
      return res.status(400).json({ error: 'Missing device id' });
    }

    try {
      const result = await withUserContext(db, user.id, (tx) =>
        tx.execute(sql`select * from public.claim_inbox_item(${device})`),
      );
      // The RPC yields a NULL-filled row when nothing was claimable.
      const row = result.rows[0] as DBSendInboxItem | undefined;
      return res.status(200).json({ item: row?.id ? row : null });
    } catch (error) {
      return res.status(500).json({ error: clientSafeMessage(error, 'Could not claim item') });
    }
  });
}
