import { sql } from 'drizzle-orm';
import type { Db } from './index';

/** The handle Drizzle hands a transaction callback. */
export type DbTx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Run `fn` with `auth.uid()` resolving to `userId`.
 *
 * Seven of the Postgres functions upstream ships read `auth.uid()` to scope
 * their own writes — `claim_inbox_item`, the three inbox transitions, and the
 * three replica-key RPCs. Their bodies are unchanged here (ADR-010), so an
 * upstream edit to any of them takes effect as-is; what changed is who supplies
 * the claim. Under Supabase, PostgREST copied it out of the JWT. Here the
 * caller sets it, and `auth.uid()` (see `drizzle/local_000_compat.sql`) reads
 * the same session variable.
 *
 * `set_config(..., true)` is transaction-local, which is why this opens one:
 * the setting is discarded at commit, so a pooled connection can never carry
 * one request's identity into the next.
 */
export const withUserContext = async <T>(
  db: Db,
  userId: string,
  fn: (tx: DbTx) => Promise<T>,
): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('request.jwt.claim.sub', ${userId}, true)`);
    return fn(tx);
  });
