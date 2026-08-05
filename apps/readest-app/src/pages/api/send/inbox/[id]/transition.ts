import { type SQL, sql } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { withDb } from '@/libs/db';
import { withUserContext } from '@/libs/db/rpc';
import { corsAllMethods, runMiddleware } from '@/utils/cors';

/**
 * Drainer state transitions for a claimed inbox item — `renew` the lease,
 * `complete`, or `fail`. Wraps the renew/complete/fail RPCs so the drainer
 * routes through the API. All three self-scope to `auth.uid()`, so they run
 * inside `withUserContext`, which supplies the subject claim PostgREST used to
 * copy out of the JWT.
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

    const id = String(req.query['id'] ?? '');
    const action = String(req.body?.action ?? '');
    const device = String(req.body?.device ?? '').slice(0, 100);
    if (!id || !device) {
      return res.status(400).json({ error: 'Missing item id or device' });
    }

    let call: SQL;
    if (action === 'renew') {
      call = sql`select public.renew_inbox_claim(${id}::uuid, ${device})`;
    } else if (action === 'complete') {
      call = sql`select public.complete_inbox_item(${id}::uuid, ${device})`;
    } else if (action === 'fail') {
      const error = String(req.body?.error ?? '').slice(0, 500);
      call = sql`select public.fail_inbox_item(${id}::uuid, ${device}, ${error})`;
    } else {
      return res.status(400).json({ error: 'Unknown action' });
    }

    try {
      const result = await withUserContext(db, user.id, (tx) => tx.execute(call));
      // Each RPC returns a single boolean column; the name is the function's.
      const value = Object.values(result.rows[0] ?? {})[0];
      return res.status(200).json({ ok: Boolean(value) });
    } catch (error) {
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Transition failed' });
    }
  });
}
