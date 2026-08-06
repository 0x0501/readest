import { and, count, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import PostalMime from 'postal-mime';
import * as schema from '../../../src/libs/db/schema';

interface Hyperdrive {
  connectionString: string;
}

interface Env {
  SEND_EMAIL_DOMAIN: string;
  MAX_MESSAGE_BYTES: string;
  INBOX_PENDING_LIMIT: string;
  HYPERDRIVE: Hyperdrive;
  INBOX_BUCKET: R2Bucket;
}

// Extensions Readest reads natively or converts client-side on import.
const ACCEPTED_EXTS = new Set([
  'epub',
  'mobi',
  'azw',
  'azw3',
  'fb2',
  'fbz',
  'zip',
  'cbz',
  'pdf',
  'txt',
  'docx',
  'rtf',
  'html',
  'htm',
]);

const normalizeEmail = (email: string): string => email.trim().toLowerCase();

const extensionOf = (filename: string): string =>
  filename.includes('.') ? filename.split('.').pop()!.toLowerCase() : '';

/** First `#tag` token in the email subject (`my book #scifi` -> `scifi`). */
const parseSubjectTag = (subject: string | undefined): string | null => {
  if (!subject) return null;
  const match = subject.match(/#([\p{L}\p{N}_-]{1,40})/u);
  return match ? match[1]! : null;
};

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    // The same connection-per-invocation the app uses (see docs/database.md,
    // ADR-004): a Worker may not hold a socket open across invocations, and
    // Hyperdrive pools on its side.
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString, max: 1 });
    const db = drizzle(pool, { schema });

    try {
      // 1. Resolve the recipient local part to a user.
      const localPart = message.to.split('@')[0]!.toLowerCase();
      const [addressRow] = await db
        .select({ userId: schema.sendAddresses.userId, enabled: schema.sendAddresses.enabled })
        .from(schema.sendAddresses)
        .where(eq(schema.sendAddresses.address, localPart))
        .limit(1);
      if (!addressRow || !addressRow.enabled) {
        // Unknown address: reject silently so there is no backscatter for a
        // guessed address.
        message.setReject('Unknown address');
        return;
      }
      const userId = addressRow.userId;

      // 2. Size guard (Cloudflare's own ceiling is ~25-30 MB).
      const maxBytes = Number(env.MAX_MESSAGE_BYTES) || 26_214_400;
      if (message.rawSize > maxBytes) {
        message.setReject('Message too large — use the Send page for large files');
        return;
      }

      // 3. Parse the MIME message.
      const rawBuffer = await new Response(message.raw).arrayBuffer();
      const parsed = await PostalMime.parse(rawBuffer);
      const fromEmail = normalizeEmail(parsed.from?.address ?? message.from);

      // 4. Approved-sender allowlist. Upstream SMTP already applies SPF, DKIM,
      // DMARC and RBL checks; this is the anti-spoofing layer the user controls.
      const [senderRow] = await db
        .select({ status: schema.sendAllowedSenders.status })
        .from(schema.sendAllowedSenders)
        .where(
          and(
            eq(schema.sendAllowedSenders.userId, userId),
            eq(schema.sendAllowedSenders.email, fromEmail),
          ),
        )
        .limit(1);
      if (!senderRow || senderRow.status !== 'approved') {
        if (!senderRow) {
          // Record the sender as pending so the user can approve it in settings.
          await db
            .insert(schema.sendAllowedSenders)
            .values({ userId, email: fromEmail, status: 'pending' });
        }
        message.setReject('Sender not approved — approve it in Readest settings');
        return;
      }

      // 5. Inbox quota — blunt a leaked-address flood. Count both pending and
      // claimed items: a crashed drainer can leave items stuck in `claimed`
      // until the lease expires, and those still occupy the inbox.
      const limit = Number(env.INBOX_PENDING_LIMIT) || 50;
      const [pending] = await db
        .select({ value: count() })
        .from(schema.sendInbox)
        .where(
          and(
            eq(schema.sendInbox.userId, userId),
            inArray(schema.sendInbox.status, ['pending', 'claimed']),
          ),
        );
      if ((pending?.value ?? 0) >= limit) {
        message.setReject('Inbox is full — open Readest to process pending items');
        return;
      }

      const subjectTag = parseSubjectTag(parsed.subject);

      // 6. Pick the first accepted attachment.
      const attachment = (parsed.attachments ?? []).find((a) =>
        ACCEPTED_EXTS.has(extensionOf(a.filename ?? '')),
      );

      if (attachment) {
        const inboxId = crypto.randomUUID();
        const filename = attachment.filename ?? 'document';
        const payloadKey = `inbox/${userId}/${inboxId}/${filename}`;
        const body =
          typeof attachment.content === 'string'
            ? new TextEncoder().encode(attachment.content)
            : new Uint8Array(attachment.content);
        await env.INBOX_BUCKET.put(payloadKey, body);
        try {
          await db.insert(schema.sendInbox).values({
            id: inboxId,
            userId,
            kind: 'file',
            source: 'email',
            payloadKey,
            filename,
            subjectTag,
            byteSize: body.byteLength,
          });
        } catch (error) {
          // The inbox row is the source of truth; without it the R2 object is
          // an unreachable orphan. Delete it and reject so the sender retries.
          console.error('Inbox insert failed:', error);
          await env.INBOX_BUCKET.delete(payloadKey).catch(() => {});
          message.setReject('Could not queue the message — please retry');
        }
        return;
      }

      // 7. No attachment: treat a URL in the body as a read-later capture.
      const urlMatch = (parsed.text ?? '').match(/https?:\/\/\S+/);
      if (urlMatch) {
        try {
          await db.insert(schema.sendInbox).values({
            userId,
            kind: 'url',
            source: 'email',
            url: urlMatch[0],
            subjectTag,
          });
        } catch (error) {
          console.error('Inbox insert failed:', error);
          message.setReject('Could not queue the message — please retry');
        }
        return;
      }

      message.setReject('No supported attachment or link found');
    } finally {
      await pool.end();
    }
  },
};
