// @vitest-environment node
//
// Runs against a real Postgres (ADR-012). Excluded from the unit lane by the
// `*.pg.test.ts` suffix; `pnpm test:pg` runs it with DATABASE_URL pointed at a
// database the migration chain has been applied to.
//
// These replace two tests that asserted the arguments handed to a mocked
// PostgREST builder — `.gt('synced_at', …)`, `.range(0, 1)`. Those arguments no
// longer exist, and asserting them never proved the rows came back in the right
// order anyway. What the pull has to get right is which rows it returns, so that
// is what is checked here.
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/libs/db/schema';

let userId = '';

// Bearer verification has its own tests; this file is about the queries behind
// it. The id is read at call time because the user is created in beforeAll.
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: userId }, token: 'tok' }),
}));

const { GET } = await import('@/pages/api/sync');

const connectionString = process.env['DATABASE_URL']!;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const pull = async (qs: string) => {
  const res = await GET(
    new Request(`https://web.readest.com/api/sync?${qs}`, {
      headers: { authorization: 'Bearer tok' },
    }) as unknown as NextRequest,
  );
  return { status: res.status, body: await res.json() };
};

const book = (hash: string) => ({
  userId,
  bookHash: hash,
  format: 'EPUB',
  title: hash,
  author: '',
});

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });

  const [row] = await db
    .insert(schema.user)
    .values({
      name: 'sync pull test',
      email: `sync-pull-${Date.now()}@example.test`,
      emailVerified: false,
    })
    .returning({ id: schema.user.id });
  userId = row!.id;
});

afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(schema.books).where(eq(schema.books.userId, userId));
  await db.delete(schema.statPages).where(eq(schema.statPages.userId, userId));
  await db.delete(schema.statBooks).where(eq(schema.statBooks.userId, userId));
});

describe('GET /api/sync?type=books&limit=N', () => {
  // A trigger stamps synced_at = now(), which is the transaction time — so rows
  // written by one statement share a synced_at and rows written by separate ones
  // do not. That is exactly the tie a batch upsert produces in production, and
  // it is why the page has to be completed past its limit.
  const seedThreeSyncedAtValues = async () => {
    await db.insert(schema.books).values(book('a'));
    await db.insert(schema.books).values([book('b'), book('c')]);
    await db.insert(schema.books).values(book('d'));
  };

  it('returns an ascending page bounded by limit, completed at the trailing synced_at', async () => {
    await seedThreeSyncedAtValues();

    const { body } = await pull('type=books&since=1&limit=2');

    // 'a' and one of the tied pair fill the page; the other tied row is pulled
    // in behind it, because a strict `> cursor` re-pull would skip it forever.
    expect(body.books.map((b: { book_hash: string }) => b.book_hash).sort()).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(body.books[0].book_hash).toBe('a');
  });

  it('returns a short page as-is when the delta is exhausted', async () => {
    await db.insert(schema.books).values(book('a'));

    const { body } = await pull('type=books&since=1&limit=5');

    expect(body.books.map((b: { book_hash: string }) => b.book_hash)).toEqual(['a']);
  });

  it('keeps the initial-race dummy tombstone for an empty since=0 page', async () => {
    const { body } = await pull('type=books&since=0&limit=2');

    expect(body.books).toHaveLength(1);
    expect(body.books[0].book_hash).toBe('00000000000000000000000000000000');
    expect(body.books[0].deleted_at).toBeTruthy();
  });

  it('returns the whole delta, newest first, when no limit is given', async () => {
    await seedThreeSyncedAtValues();

    const { body } = await pull('type=books&since=1');

    expect(body.books).toHaveLength(4);
    expect(body.books[0].book_hash).toBe('d');
  });
});

describe('GET /api/sync?type=stats', () => {
  const page = (bookHash: string, startTime: number) => ({
    userId,
    bookHash,
    page: 1,
    startTime,
    duration: 10,
    totalPages: 100,
  });

  it('excludes rows at or before the cursor', async () => {
    // Stamped rather than left to now(): a Postgres timestamp carries
    // microseconds and the client's cursor is whole milliseconds, so a cursor
    // read back from a row lands just under it and the row returns again.
    const t = Date.parse('2026-01-01T00:00:00.000Z');
    await db.insert(schema.statPages).values([
      { ...page('bk', 1), updatedAt: new Date(t).toISOString() },
      { ...page('bk', 2), updatedAt: new Date(t + 10_000).toISOString() },
    ]);

    const { body } = await pull(`type=stats&since=${t + 1_000}`);

    expect(body.statPages.map((p: { start_time: number }) => p.start_time)).toEqual([2]);
  });

  // The cursor is `updated_at > since` alone. Dropping the `OR deleted_at >
  // since` that used to sit beside it is only safe because every push stamps
  // updated_at server-side, deletes included — so a delete is always newer than
  // any peer's cursor and the plain range predicate already returns it.
  it('returns a delete, which is why the deleted_at clause is not needed', async () => {
    await db.insert(schema.statPages).values(page('bk', 1));
    const cursor = Date.now();
    await db
      .update(schema.statPages)
      .set({ deletedAt: new Date().toISOString(), updatedAt: sql`now()` })
      .where(eq(schema.statPages.userId, userId));

    const { body } = await pull(`type=stats&since=${cursor}`);

    expect(body.statPages).toHaveLength(1);
    expect(body.statPages[0].deleted_at).toBeTruthy();
  });

  it('attaches updated_at_ms so non-JS clients need not parse ISO-8601', async () => {
    await db.insert(schema.statBooks).values({ userId, bookHash: 'bk', title: 't', authors: 'a' });

    const { body } = await pull('type=stats&since=1');

    expect(body.statBooks).toHaveLength(1);
    expect(body.statBooks[0].updated_at_ms).toBe(
      new Date(body.statBooks[0].updated_at as string).getTime(),
    );
  });
});
