import { and, count, desc, eq, inArray } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { SEND_INBOX_BUCKET, SEND_INBOX_PENDING_LIMIT } from '@/services/constants';
import { parseSubjectTag } from '@/services/send/sendAddress';
import type { DBSendInboxItem } from '@/types/sendRecords';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { putObject } from '@/utils/object';

const RECENT_LIMIT = 20;
const MAX_CLIP_HTML_BYTES = 5 * 1024 * 1024;

// snake_case is the shape the client already reads.
const toWire = (row: typeof schema.sendInbox.$inferSelect): DBSendInboxItem => ({
  id: row.id,
  user_id: row.userId,
  kind: row.kind as DBSendInboxItem['kind'],
  source: row.source as DBSendInboxItem['source'],
  payload_key: row.payloadKey,
  url: row.url,
  filename: row.filename,
  subject_tag: row.subjectTag,
  byte_size: row.byteSize,
  status: row.status as DBSendInboxItem['status'],
  claimed_by: row.claimedBy,
  claimed_at: row.claimedAt,
  attempts: row.attempts,
  error: row.error,
  created_at: row.createdAt,
  updated_at: row.updatedAt,
});

/**
 * Inbox endpoint — clients route through here rather than querying the
 * database directly.
 *  GET  — list the caller's recent inbox items (the "Recent activity" list).
 *  POST — authenticated producer (browser extension): drop a captured URL in.
 *         (The email channel writes `send_inbox` from the email Worker.)
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  return withDb(async (db) => {
    const { user } = await validateUserAndToken(db, req.headers['authorization']);
    if (!user) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    // Every query below is scoped to the caller, which is the whole of the
    // authorization now that RLS is not enforcing it (ADR-005).
    const mine = eq(schema.sendInbox.userId, user.id);

    try {
      if (req.method === 'GET') {
        const rows = await db
          .select()
          .from(schema.sendInbox)
          .where(mine)
          .orderBy(desc(schema.sendInbox.createdAt))
          .limit(RECENT_LIMIT);
        return res.status(200).json({ items: rows.map(toWire) });
      }

      if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
      }

      // Anti-abuse: cap undrained items so a leaked token can't flood R2 or the
      // user's library. Count claimed items too — a crashed drainer can leave
      // items stuck in `claimed` until the lease expires.
      const [pending] = await db
        .select({ value: count() })
        .from(schema.sendInbox)
        .where(and(mine, inArray(schema.sendInbox.status, ['pending', 'claimed'])));
      if ((pending?.value ?? 0) >= SEND_INBOX_PENDING_LIMIT) {
        return res
          .status(429)
          .json({ error: 'Inbox is full — open Readest to process pending items' });
      }

      const kind = String(req.body?.kind ?? 'url');

      if (kind === 'html') {
        // Bookmarklet / extension path: caller posts the page's rendered HTML.
        // This bypasses bot-protection that would defeat a server-side fetch
        // (CAPTCHAs, login walls, JS-rendered content). The HTML lands in R2 and
        // the drainer converts it identically to the email-attachment flow.
        const html = String(req.body?.html ?? '');
        if (!html) return res.status(400).json({ error: 'html is required' });
        const bytes = new TextEncoder().encode(html);
        if (bytes.byteLength > MAX_CLIP_HTML_BYTES) {
          return res.status(413).json({ error: 'Page is too large to send' });
        }
        const title = req.body?.title ? String(req.body.title).slice(0, 500) : null;
        const sourceUrl = req.body?.url ? String(req.body.url).slice(0, 2000) : null;

        const [row] = await db
          .insert(schema.sendInbox)
          .values({
            userId: user.id,
            kind: 'html',
            source: 'extension',
            url: sourceUrl,
            filename: title,
            byteSize: bytes.byteLength,
            subjectTag: parseSubjectTag(title) ?? null,
          })
          .returning({ id: schema.sendInbox.id });
        if (!row) return res.status(500).json({ error: 'Could not create inbox item' });

        const payloadKey = `inbox/${user.id}/${row.id}/page.html`;
        try {
          await putObject(payloadKey, bytes.buffer, 'text/html; charset=utf-8', SEND_INBOX_BUCKET);
        } catch (err) {
          // Roll back the inbox row so we never leave a `pending` item the
          // drainer would only fail on.
          await db.delete(schema.sendInbox).where(eq(schema.sendInbox.id, row.id));
          console.error('Inbox clip upload failed:', err);
          return res.status(500).json({ error: 'Could not store page' });
        }

        await db
          .update(schema.sendInbox)
          .set({ payloadKey })
          .where(eq(schema.sendInbox.id, row.id));

        return res.status(200).json({ id: row.id });
      }

      // kind === 'url' (legacy extension path)
      const url = String(req.body?.url ?? '').trim();
      if (!url || !/^https?:\/\//i.test(url)) {
        return res.status(400).json({ error: 'A valid http(s) URL is required' });
      }
      const title = req.body?.title ? String(req.body.title) : null;

      const [row] = await db
        .insert(schema.sendInbox)
        .values({
          userId: user.id,
          kind: 'url',
          source: 'extension',
          url,
          filename: title,
          subjectTag: parseSubjectTag(title) ?? null,
        })
        .returning({ id: schema.sendInbox.id });
      if (!row) return res.status(500).json({ error: 'Could not create inbox item' });

      return res.status(200).json({ id: row.id });
    } catch (error) {
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Request failed' });
    }
  });
}
