import { and, asc, eq } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { EMAIL_IN_PLANS, getUserProfilePlan, isEmailInPlan } from '@/utils/access';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { normalizeSenderEmail } from '@/services/send/sendAddress';
import type { DBSendAllowedSender } from '@/types/sendRecords';

// Linear-time email check: domain labels exclude '.' so there is no
// quantifier ambiguity (a polynomial-backtracking ReDoS would need it).
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_EMAIL_LENGTH = 254;

/**
 * The approved-sender allowlist.
 *  GET    — list the caller's senders (approved + pending).
 *  POST   — add an approved sender `{ email }`.
 *  PATCH  — approve a pending sender `{ id }`.
 *  DELETE — remove a sender `{ id }`.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
    if (!user || !token) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    // Sender allowlist only matters for the email-in channel — gate it too.
    const plan = getUserProfilePlan(token);
    if (!isEmailInPlan(plan)) {
      return res.status(403).json({
        error: 'Email-in is available on the Plus, Pro, and Lifetime plans',
        code: 'plan_required',
        plan,
        requiredPlans: EMAIL_IN_PLANS,
      });
    }

    // Every branch is scoped to the caller, which is the whole of the
    // authorization now that RLS is not enforcing it (ADR-005).
    const mine = eq(schema.sendAllowedSenders.userId, user.id);

    try {
      if (req.method === 'GET') {
        const senders = await db
          .select()
          .from(schema.sendAllowedSenders)
          .where(mine)
          .orderBy(asc(schema.sendAllowedSenders.createdAt));
        return res.status(200).json({ senders: toWire(senders) });
      }

      if (req.method === 'POST') {
        const email = normalizeSenderEmail(String(req.body?.email ?? ''));
        if (email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
          return res.status(400).json({ error: 'Invalid email address' });
        }
        const [sender] = await db
          .insert(schema.sendAllowedSenders)
          .values({ userId: user.id, email, status: 'approved' })
          .onConflictDoUpdate({
            target: [schema.sendAllowedSenders.userId, schema.sendAllowedSenders.email],
            set: { status: 'approved' },
          })
          .returning();
        return res.status(200).json({ sender: sender ? toWire([sender])[0] : null });
      }

      if (req.method === 'PATCH') {
        const id = String(req.body?.id ?? '');
        if (!id) return res.status(400).json({ error: 'Missing sender id' });
        const [sender] = await db
          .update(schema.sendAllowedSenders)
          .set({ status: 'approved' })
          .where(and(eq(schema.sendAllowedSenders.id, id), mine))
          .returning();
        if (!sender) return res.status(404).json({ error: 'Sender not found' });
        return res.status(200).json({ sender: toWire([sender])[0] });
      }

      if (req.method === 'DELETE') {
        const id = String(req.body?.id ?? req.query['id'] ?? '');
        if (!id) return res.status(400).json({ error: 'Missing sender id' });
        await db
          .delete(schema.sendAllowedSenders)
          .where(and(eq(schema.sendAllowedSenders.id, id), mine));
        return res.status(200).json({ ok: true });
      }

      return res.status(405).json({ error: 'Method not allowed' });
    } catch (error) {
      return res
        .status(500)
        .json({ error: error instanceof Error ? error.message : 'Request failed' });
    }
  });
}

// snake_case is the shape the client already reads.
const toWire = (rows: (typeof schema.sendAllowedSenders.$inferSelect)[]): DBSendAllowedSender[] =>
  rows.map((row) => ({
    id: row.id,
    user_id: row.userId,
    email: row.email,
    status: row.status as DBSendAllowedSender['status'],
    created_at: row.createdAt,
  }));
