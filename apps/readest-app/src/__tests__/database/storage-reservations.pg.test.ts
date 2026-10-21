// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { Pool } from 'pg';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/libs/db/schema';

const state = vi.hoisted(() => ({ userId: '', quota: 1000, failSign: false }));
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: state.userId }, token: 'test-token' }),
}));
vi.mock('@/utils/access', () => ({
  getStoragePlanData: () => ({ usage: 0, quota: state.quota }),
  STORAGE_QUOTA_GRACE_BYTES: 0,
}));
vi.mock('@/utils/cors', () => ({ corsAllMethods: {}, runMiddleware: async () => {} }));
vi.mock('@/utils/object', async (original) => ({
  ...(await original<typeof import('@/utils/object')>()),
  getUploadSignedUrl: async () => {
    if (state.failSign) throw new Error('signing failed');
    return 'https://storage.example/upload';
  },
  objectExists: async () => true,
  copyObject: async () => new Response(null, { status: 200 }),
}));
vi.mock('@/libs/shareServer', () => ({
  rejectionToHttp: vi.fn(),
  resolveActiveShare: async () => ({
    ok: true,
    share: {
      userId: 'sharer',
      bookHash: 'shared-book',
      bookSize: 100,
      bookFileKey: 'sharer/Readest/Book/shared-book/book.epub',
      coverFileKey: null,
      cfi: null,
    },
  }),
}));
import uploadHandler from '@/pages/api/storage/upload';
import { POST as importShare } from '@/app/api/share/[token]/import/route';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const db = drizzle(pool, { schema });
const upload = async (name: string, size: unknown, options: Record<string, unknown> = {}) => {
  let status = 200;
  let body: unknown;
  const response = {
    status(value: number) {
      status = value;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  await uploadHandler(
    {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
      body: { fileName: name, fileSize: size, ...options },
    } as unknown as NextApiRequest,
    response as unknown as NextApiResponse,
  );
  return { status, body };
};
const share = () =>
  importShare(
    new Request('https://reader.example/api/share/test/import', {
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    }),
    { params: Promise.resolve({ token: 'test' }) },
  );
const files = () => db.select().from(schema.files).where(eq(schema.files.userId, state.userId));
const used = async () =>
  Number(
    (
      await db
        .select({ used: sum(schema.files.fileSize) })
        .from(schema.files)
        .where(and(eq(schema.files.userId, state.userId), isNull(schema.files.deletedAt)))
    )[0]?.used ?? 0,
  );
const seed = (size: number) =>
  db
    .insert(schema.files)
    .values({ userId: state.userId, fileKey: `${state.userId}/${randomUUID()}`, fileSize: size });

beforeAll(async () => {
  state.userId = randomUUID();
  await db.insert(schema.user).values({
    id: state.userId,
    name: 'Storage test',
    email: `${state.userId}@example.test`,
    emailVerified: false,
  });
});
beforeEach(async () => {
  state.quota = 1000;
  state.failSign = false;
  await db.delete(schema.files).where(eq(schema.files.userId, state.userId));
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, state.userId));
  await pool.end();
});

describe('upload reservations', () => {
  it('enforces live usage despite an empty usage claim', async () => {
    await seed(950);
    expect((await upload('book.epub', 100)).status).toBe(403);
    expect(await used()).toBe(950);
    expect(await files()).toHaveLength(1);
  });
  it('does not let concurrent uploads overshoot the account quota', async () => {
    const results = await Promise.all([upload('a.epub', 700), upload('b.epub', 700)]);
    expect(results.every((r) => [200, 403].includes(r.status))).toBe(true);
    expect(results.filter((r) => r.status === 200).length).toBeLessThanOrEqual(1);
    expect(await used()).toBeLessThanOrEqual(1000);
    expect(await files()).toHaveLength(results.filter((r) => r.status === 200).length);
  });
  it('reuses the recorded size without charging a re-upload twice', async () => {
    expect((await upload('book.epub', 900)).status).toBe(200);
    expect((await upload('book.epub', 999)).body).toMatchObject({ usage: 900 });
    expect(await files()).toHaveLength(1);
    expect(await used()).toBe(900);
  });
  it('removes a reservation when signing fails', async () => {
    state.failSign = true;
    expect((await upload('book.epub', 100)).status).toBe(500);
    expect(await files()).toHaveLength(0);
  });
  it.each([-1, 0, 1.5, '100', Infinity])('rejects invalid sizes: %s', async (size) => {
    expect((await upload('book.epub', size)).status).toBe(400);
    expect(await files()).toHaveLength(0);
  });
  it('caps unmetered public image uploads', async () => {
    expect((await upload('cover.png', 21 * 1024 * 1024, { temp: true })).status).toBe(413);
    expect((await upload('cover.png', 21 * 1024 * 1024, { media: 'book_covers' })).status).toBe(
      413,
    );
  });
});

describe('share import reservations', () => {
  it('removes a new destination row when it exceeds live quota', async () => {
    await seed(950);
    expect((await share()).status).toBe(402);
    expect(await used()).toBe(950);
    expect(await files()).toHaveLength(1);
  });
  it('restores the tombstone when a deleted book cannot fit', async () => {
    await seed(950);
    await db.insert(schema.files).values({
      userId: state.userId,
      bookHash: 'shared-book',
      fileKey: `${state.userId}/Readest/Book/shared-book/book.epub`,
      fileSize: 100,
      deletedAt: '2026-01-01T00:00:00Z',
    });
    expect((await share()).status).toBe(402);
    const restored = (await files()).find((f) => f.bookHash === 'shared-book');
    expect(restored?.deletedAt).not.toBeNull();
    expect(await used()).toBe(950);
  });
  it('imports within quota and returns an existing import without another charge', async () => {
    expect((await share()).status).toBe(200);
    expect(await (await share()).json()).toMatchObject({ alreadyOwned: true });
    expect(await used()).toBe(100);
    expect(await files()).toHaveLength(1);
  });
});
