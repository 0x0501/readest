import { and, eq } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { SEND_INBOX_BUCKET } from '@/services/constants';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { getDownloadSignedUrl } from '@/utils/object';

const DOWNLOAD_TTL_SECONDS = 600;

/**
 * Signed-download URL for an inbox payload. Authorizes against `send_inbox`
 * ownership — a separate path from `storage/download`, which checks the
 * `files` table (inbox payloads are not `files` rows).
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  return withDb(async (db) => {
    const { user } = await validateUserAndToken(db, req.headers['authorization']);
    if (!user) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    const id = String(req.query['id'] ?? '');
    if (!id) {
      return res.status(400).json({ error: 'Missing inbox item id' });
    }

    // Scoped by user_id in the query, so another user's item is a 404 and the
    // caller learns nothing about it (ADR-005).
    let item: { payloadKey: string | null } | undefined;
    try {
      [item] = await db
        .select({ payloadKey: schema.sendInbox.payloadKey })
        .from(schema.sendInbox)
        .where(and(eq(schema.sendInbox.id, id), eq(schema.sendInbox.userId, user.id)))
        .limit(1);
    } catch (error) {
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Lookup failed' });
    }
    if (!item) {
      return res.status(404).json({ error: 'Inbox item not found' });
    }
    if (!item.payloadKey) {
      return res.status(409).json({ error: 'Inbox item has no file payload' });
    }

    try {
      // Inbox payloads live in their own bucket, separate from the books bucket
      // that getDownloadSignedUrl defaults to.
      const downloadUrl = await getDownloadSignedUrl(
        item.payloadKey,
        DOWNLOAD_TTL_SECONDS,
        SEND_INBOX_BUCKET,
      );
      return res.status(200).json({ downloadUrl });
    } catch (err) {
      console.error('Inbox payload sign failed:', err);
      return res.status(500).json({ error: 'Could not sign payload URL' });
    }
  });
}
