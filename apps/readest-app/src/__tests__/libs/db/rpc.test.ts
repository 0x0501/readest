// @vitest-environment node
import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import type { Db } from '@/libs/db';
import { type DbTx, withUserContext } from '@/libs/db/rpc';

const dialect = new PgDialect();

/**
 * Records every statement the callback issues, in order, so the test can assert
 * that the identity is set before anything reads `auth.uid()`.
 */
const recordingDb = (log: SQL[]) =>
  ({
    transaction: <T>(fn: (tx: DbTx) => Promise<T>) =>
      fn({
        execute: (query: SQL) => {
          log.push(query);
          return Promise.resolve({ rows: [] });
        },
      } as unknown as DbTx),
  }) as unknown as Db;

describe('withUserContext', () => {
  it('sets the subject claim transaction-locally before running the callback', async () => {
    const log: SQL[] = [];
    const db = recordingDb(log);

    await withUserContext(db, 'user-1', (tx) => tx.execute(sql`select claim_inbox_item()`));

    const { sql: text, params } = dialect.sqlToQuery(log[0]!);
    expect(text).toContain("set_config('request.jwt.claim.sub'");
    // `true` is is_local: discarded at commit, so a pooled connection cannot
    // carry one request's identity into the next.
    expect(text).toContain('true');
    expect(params).toEqual(['user-1']);
  });

  it('runs the callback inside the same transaction, after the claim', async () => {
    const log: SQL[] = [];
    const db = recordingDb(log);

    await withUserContext(db, 'user-1', (tx) => tx.execute(sql`select replica_keys_list()`));

    expect(log).toHaveLength(2);
    expect(dialect.sqlToQuery(log[1]!).sql).toContain('replica_keys_list');
  });

  it('returns whatever the callback returns', async () => {
    const db = recordingDb([]);
    await expect(withUserContext(db, 'user-1', async () => 'result')).resolves.toBe('result');
  });
});
