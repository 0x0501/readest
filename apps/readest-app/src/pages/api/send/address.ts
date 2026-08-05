import { eq, sql } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { getUserEmail, validateUserAndToken } from '@/libs/auth/verify';
import { type Db, schema, withDb } from '@/libs/db';
import { SEND_EMAIL_DOMAIN } from '@/services/constants';
import {
  buildSendAddress,
  generateSendAddress,
  isReservedSlug,
  normalizeSenderEmail,
  sanitizeSlug,
} from '@/services/send/sendAddress';
import { EMAIL_IN_PLANS, getUserProfilePlan, isEmailInPlan } from '@/utils/access';
import { corsAllMethods, runMiddleware } from '@/utils/cors';

const MAX_COLLISION_RETRIES = 5;

// Postgres unique_violation. Raised either by the `user_id` primary key when a
// concurrent request created the row first, or by the unique index on
// `address` when two users happened to draw the same local part.
const UNIQUE_VIOLATION = '23505';

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === UNIQUE_VIOLATION;

/** Build the full inbound email address from a stored local part. */
const fullAddress = (localPart: string) => `${localPart}@${SEND_EMAIL_DOMAIN}`;

/**
 * GET  — return the caller's inbound address, lazily creating one on first call.
 * POST — rotate the address (issue a fresh random local part).
 *
 * The address is the local part only in the DB; the `@send.readest.com` host
 * is appended here so the domain can change without a migration.
 */
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
    if (!user || !token) {
      return res.status(403).json({ error: 'Not authenticated' });
    }

    // Email-in is a paid feature. The client renders a friendly upgrade
    // card on receiving this response, so the structured body (code +
    // requiredPlans) matters — UI keys off it.
    const plan = getUserProfilePlan(token);
    if (!isEmailInPlan(plan)) {
      return res.status(403).json({
        error: 'Email-in is available on the Plus, Pro, and Lifetime plans',
        code: 'plan_required',
        plan,
        requiredPlans: EMAIL_IN_PLANS,
      });
    }

    if (req.method === 'GET') {
      const [existing] = await db
        .select({ address: schema.sendAddresses.address, enabled: schema.sendAddresses.enabled })
        .from(schema.sendAddresses)
        .where(eq(schema.sendAddresses.userId, user.id))
        .limit(1);
      if (existing) {
        return res
          .status(200)
          .json({ address: fullAddress(existing.address), enabled: existing.enabled });
      }

      // Lazily create on first access.
      const email = await getUserEmail(db, user.id);
      const created = await insertWithRetry(db, user.id, email ?? user.id);
      if (!created) {
        return res.status(500).json({ error: 'Could not allocate an address' });
      }
      // Auto-seed the allowlist with the user's account email so the most common
      // first send ("email it to yourself") works without a separate approval.
      // Best-effort: address creation succeeds even if the seed insert fails.
      if (email) {
        await seedOwnEmail(db, user.id, email);
      }
      return res.status(200).json({ address: fullAddress(created), enabled: true });
    }

    if (req.method === 'POST') {
      // Optional custom slug; the token suffix is always regenerated. Without a
      // slug this is a plain rotation with an identity-derived slug.
      let customSlug: string | undefined;
      if (req.body?.slug !== undefined) {
        customSlug = sanitizeSlug(String(req.body.slug));
        if (!customSlug) {
          return res.status(400).json({ error: 'Name must contain letters or digits' });
        }
        if (isReservedSlug(customSlug)) {
          return res.status(400).json({ error: 'That name is reserved' });
        }
      }

      const identity = customSlug ? null : ((await getUserEmail(db, user.id)) ?? user.id);

      // Rotation: overwrite with a fresh local part. `user_id` is the primary
      // key, so this is an upsert.
      for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
        const localPart = customSlug
          ? buildSendAddress(customSlug)
          : generateSendAddress(identity!);
        try {
          await db
            .insert(schema.sendAddresses)
            .values({ userId: user.id, address: localPart, enabled: true })
            .onConflictDoUpdate({
              target: schema.sendAddresses.userId,
              set: { address: localPart, enabled: true, rotatedAt: sql`now()` },
            });
          return res.status(200).json({ address: fullAddress(localPart), enabled: true });
        } catch (error) {
          // Someone else already holds this local part — draw another.
          if (!isUniqueViolation(error)) {
            return res
              .status(500)
              .json({ error: error instanceof Error ? error.message : 'Rotation failed' });
          }
        }
      }
      return res.status(500).json({ error: 'Could not allocate an address' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  });
}

async function seedOwnEmail(db: Db, userId: string, email: string): Promise<void> {
  const normalized = normalizeSenderEmail(email);
  if (!normalized) return;
  await db
    .insert(schema.sendAllowedSenders)
    .values({ userId, email: normalized, status: 'approved' })
    .onConflictDoUpdate({
      target: [schema.sendAllowedSenders.userId, schema.sendAllowedSenders.email],
      set: { status: 'approved' },
    });
}

async function insertWithRetry(db: Db, userId: string, identity: string): Promise<string | null> {
  for (let attempt = 0; attempt < MAX_COLLISION_RETRIES; attempt++) {
    const localPart = generateSendAddress(identity);
    try {
      await db.insert(schema.sendAddresses).values({ userId, address: localPart, enabled: true });
      return localPart;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      // Either a concurrent request created this user's row — read it back —
      // or the drawn local part is taken, in which case the next attempt draws
      // another.
      const [existing] = await db
        .select({ address: schema.sendAddresses.address })
        .from(schema.sendAddresses)
        .where(eq(schema.sendAddresses.userId, userId))
        .limit(1);
      if (existing) return existing.address;
    }
  }
  return null;
}
