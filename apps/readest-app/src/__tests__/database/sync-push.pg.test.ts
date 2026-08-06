// @vitest-environment node
//
// Runs against a real Postgres (ADR-012); `pnpm test:pg` runs it with
// DATABASE_URL pointed at a migrated database.
//
// The resolvers this push is built on — resolveReadingStatusMerge,
// resolveCoverMerge, resolveMetadataMerge — are unit-tested as pure functions.
// What was never covered is the part around them: which rows the batch reads
// back, what a graft actually writes, and what shape the values come out in.
// That is where a snake_case/camelCase or a JSON-encoding mistake would live.
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/libs/db/schema';

let userId = '';

vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: userId }, token: 'tok' }),
}));

const { GET, POST } = await import('@/pages/api/sync');

const connectionString = process.env['DATABASE_URL']!;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const push = async (body: unknown) => {
  const res = await POST(
    new Request('https://web.readest.com/api/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest,
  );
  return { status: res.status, body: await res.json() };
};

const pull = async (qs: string) => {
  const res = await GET(
    new Request(`https://web.readest.com/api/sync?${qs}`, {
      headers: { authorization: 'Bearer tok' },
    }) as unknown as NextRequest,
  );
  return res.json();
};

// The client-side shape, which `transformBookToDB` turns into columns.
const clientBook = (hash: string, updatedAt: number, extra: Record<string, unknown> = {}) => ({
  hash,
  format: 'EPUB',
  title: hash,
  author: 'an author',
  createdAt: updatedAt,
  updatedAt,
  ...extra,
});

const bookRow = (hash: string) =>
  db.query.books.findFirst({
    where: and(eq(schema.books.userId, userId), eq(schema.books.bookHash, hash)),
  });

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });

  const [row] = await db
    .insert(schema.user)
    .values({
      name: 'sync push test',
      email: `sync-push-${Date.now()}@example.test`,
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
  await db.delete(schema.bookConfigs).where(eq(schema.bookConfigs.userId, userId));
  await db.delete(schema.bookNotes).where(eq(schema.bookNotes.userId, userId));
  await db.delete(schema.statPages).where(eq(schema.statPages.userId, userId));
});

describe('POST /api/sync books', () => {
  it('inserts a book the server has never seen and returns it', async () => {
    const { status, body } = await push({ books: [clientBook('a', 1_000)] });

    expect(status).toBe(200);
    expect(body.books).toHaveLength(1);
    expect(body.books[0].book_hash).toBe('a');
    await expect(bookRow('a').then((r) => r?.title)).resolves.toBe('a');
  });

  // An insert stamps updated_at = now() and discards whatever the client sent,
  // so a row's server timestamp is real time from the moment it exists — a
  // second push has to be newer than that, not merely newer than the first push.
  it('takes the client row when it is newer', async () => {
    await push({ books: [clientBook('a', 1_000)] });
    await push({ books: [clientBook('a', Date.now() + 60_000, { title: 'renamed' })] });

    await expect(bookRow('a').then((r) => r?.title)).resolves.toBe('renamed');
  });

  it('keeps the server row when the client is older, and hands the client that row back', async () => {
    await push({ books: [clientBook('a', 5_000, { title: 'server wins' })] });
    const { body } = await push({ books: [clientBook('a', 1_000, { title: 'stale' })] });

    expect(body.books[0].title).toBe('server wins');
    await expect(bookRow('a').then((r) => r?.title)).resolves.toBe('server wins');
  });

  // A page-turn dominates updated_at, so reading_status carries its own clock.
  // The graft must land without touching updated_at, or the date-read library
  // reorders itself on every sync (#4678).
  it('grafts a newer reading_status onto a server row without moving updated_at', async () => {
    await push({ books: [clientBook('a', 5_000)] });
    const before = await bookRow('a');

    await push({
      books: [clientBook('a', 1_000, { readingStatus: 'finished', readingStatusUpdatedAt: 9_000 })],
    });

    const after = await bookRow('a');
    expect(after?.readingStatus).toBe('finished');
    expect(after?.updatedAt).toBe(before?.updatedAt);
    // synced_at is what makes peers re-pull the graft.
    expect(new Date(after!.syncedAt!).getTime()).toBeGreaterThan(
      new Date(before!.syncedAt!).getTime(),
    );
  });

  it('leaves the row alone when the status timestamp moved but the value did not', async () => {
    await push({ books: [clientBook('a', 5_000, { readingStatus: 'reading' })] });
    const before = await bookRow('a');

    await push({
      books: [clientBook('a', 1_000, { readingStatus: 'reading', readingStatusUpdatedAt: 9_000 })],
    });

    expect((await bookRow('a'))?.syncedAt).toBe(before?.syncedAt);
  });
});

describe('POST /api/sync book_notes', () => {
  const note = (id: string, updatedAt: number, text: string) => ({
    bookHash: 'a',
    id,
    type: 'annotation',
    text,
    createdAt: updatedAt,
    updatedAt,
  });

  // Two key columns, which the batch read matches as a superset and then narrows
  // in memory — the one place where getting the key wrong would silently merge
  // two different notes.
  it('keys notes on (book_hash, id) rather than book_hash alone', async () => {
    await push({ notes: [note('n1', 1_000, 'first'), note('n2', 1_000, 'second')] });

    const rows = await db
      .select({ id: schema.bookNotes.id, text: schema.bookNotes.text })
      .from(schema.bookNotes)
      .where(eq(schema.bookNotes.userId, userId));

    expect(rows.sort((x, y) => x.id.localeCompare(y.id))).toEqual([
      { id: 'n1', text: 'first' },
      { id: 'n2', text: 'second' },
    ]);
  });
});

describe('POST /api/sync book_configs', () => {
  const config = (bookHash: string, updatedAt: number, progress: [number, number]) => ({
    bookHash,
    updatedAt,
    progress,
    viewSettings: { fontSize: 16 },
  });

  // The client stringifies these before sending and JSON.parses them on the way
  // back. Anything that re-encodes them in between breaks a reader's saved
  // position without any error to show for it.
  it('returns progress and view_settings as the strings the client parses', async () => {
    await push({ configs: [config('a', 1_000, [3, 10])] });

    const body = await pull('type=configs&since=1');

    expect(body.configs).toHaveLength(1);
    expect(typeof body.configs[0].progress).toBe('string');
    expect(JSON.parse(body.configs[0].progress)).toEqual([3, 10]);
    expect(JSON.parse(body.configs[0].view_settings)).toEqual({ fontSize: 16 });
  });

  it('piggybacks the pushed progress onto the books row', async () => {
    await push({ books: [clientBook('a', 1_000)] });
    await push({ configs: [config('a', 2_000, [3, 10])] });

    await expect(bookRow('a').then((r) => r?.progress)).resolves.toEqual([3, 10]);
  });

  it('does not downgrade a books row that is already newer', async () => {
    // Seeded directly: a pushed insert would stamp updated_at = now() and the
    // config written a moment later would then be the newer of the two.
    await db.insert(schema.books).values({
      userId,
      bookHash: 'a',
      format: 'EPUB',
      title: 'a',
      author: 'an author',
      updatedAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await push({ configs: [config('a', 2_000, [3, 10])] });

    await expect(bookRow('a').then((r) => r?.progress)).resolves.toBeNull();
  });
});

describe('POST /api/sync stat_pages', () => {
  const page = (startTime: number, duration: number) => ({
    book_hash: 'a',
    page: 1,
    start_time: startTime,
    duration,
    total_pages: 100,
  });

  const durations = async () =>
    (
      await db
        .select({ duration: schema.statPages.duration })
        .from(schema.statPages)
        .where(eq(schema.statPages.userId, userId))
    ).map((r) => r.duration);

  it('keeps the longer duration for a page event it already has', async () => {
    await push({ statPages: [page(1, 30)] });
    await push({ statPages: [page(1, 12)] });

    await expect(durations()).resolves.toEqual([30]);
  });

  it('takes the longer duration when the incoming one wins', async () => {
    await push({ statPages: [page(1, 12)] });
    await push({ statPages: [page(1, 30)] });

    await expect(durations()).resolves.toEqual([30]);
  });
});
