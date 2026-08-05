import { vi } from 'vitest';
import type { Db } from '@/libs/db';

/**
 * A stand-in for the Drizzle handle, for tests about a route's behaviour rather
 * than its SQL.
 *
 * Every builder method returns the same object and the object is thenable, so
 * any chain the routes build — `select().from().where().limit()`,
 * `insert().values().returning()`, `update().set().where()` — resolves to the
 * next queued result. Queue one array per statement the code under test is
 * expected to run, in order; anything past the end resolves to `[]`.
 *
 * Assertions about *which* rows a query would return belong in a `*.pg.test.ts`
 * against a real Postgres (ADR-012). This is for "does the handler presign
 * before or after it checks the token".
 */
export const stubDb = (results: unknown[][] = []) => {
  const queue = [...results];
  const calls: { method: string; args: unknown[] }[] = [];

  const chain: Record<string, unknown> = {
    // biome-ignore lint/suspicious/noThenProperty: deliberate — Drizzle's query builders are thenable, and this stands in for one
    then: (resolve: (value: unknown) => unknown) =>
      Promise.resolve(queue.shift() ?? []).then(resolve),
  };
  for (const method of [
    'select',
    'from',
    'where',
    'limit',
    'offset',
    'orderBy',
    'groupBy',
    'insert',
    'values',
    'returning',
    'onConflictDoUpdate',
    'update',
    'set',
    'delete',
    'execute',
  ]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }

  const db = {
    ...chain,
    transaction: (fn: (tx: unknown) => unknown) => fn(chain),
  } as unknown as Db;

  return { db, calls, withDb: vi.fn(<T>(fn: (handle: Db) => Promise<T>) => fn(db)) };
};
