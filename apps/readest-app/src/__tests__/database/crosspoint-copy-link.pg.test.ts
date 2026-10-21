// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import * as schema from '@/libs/db/schema';
import { hashDeviceKey, linkCopy, linkedBook } from '@/libs/crosspoint';
import { PUT } from '@/app/api/crosspoint/syncs/progress/route';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const db = drizzle(pool, { schema });
const userId = randomUUID();
const bookHash = 'a'.repeat(32);
const document = 'b'.repeat(32);
const key = 'test-device-key';
beforeAll(async () => {
  await db.insert(schema.user).values({
    id: userId,
    name: 'Copy test',
    email: `${userId}@example.test`,
    emailVerified: false,
  });
  await db.insert(schema.crosspointDevices).values({ userId, keyHash: await hashDeviceKey(key) });
  await db
    .insert(schema.books)
    .values({ userId, bookHash, title: 'A Book', author: 'An Author', format: 'EPUB' });
});
beforeEach(async () => {
  await db.delete(schema.crosspointDocuments).where(eq(schema.crosspointDocuments.userId, userId));
  await db.delete(schema.bookConfigs).where(eq(schema.bookConfigs.userId, userId));
});
afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await pool.end();
});
it('links a rewritten file to the matching book and persists the account-scoped mapping', async () => {
  expect(await linkCopy(db, userId, document, { title: 'a book', authors: 'An Author' })).toEqual({
    bookHash,
    error: null,
  });
  expect(await linkedBook(db, userId, document)).toEqual({ bookHash, error: null });
  expect((await linkedBook(db, randomUUID(), document)).bookHash).toBeNull();
});
it('does not map the original file or a title absent from this account', async () => {
  expect((await linkCopy(db, userId, bookHash, { title: 'A Book' })).bookHash).toBeNull();
  expect((await linkCopy(db, randomUUID(), document, { title: 'A Book' })).bookHash).toBeNull();
});
it('keeps existing reading progress when a fresh copy first announces its start', async () => {
  await db.insert(schema.bookConfigs).values({
    userId,
    bookHash,
    progress: [60, 120],
    xpointer: '/body/original',
    updatedAt: '2026-01-01T00:00:00Z',
  });
  const response = await PUT(
    new Request('https://reader.example/api/crosspoint/syncs/progress', {
      method: 'PUT',
      headers: { authorization: `Bearer ${key}` },
      body: JSON.stringify({
        document,
        progress: '/body/copy',
        percentage: 0.01,
        metadata: { title: 'A Book', authors: 'An Author' },
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect((await linkedBook(db, userId, document)).bookHash).toBe(bookHash);
  const [config] = await db
    .select()
    .from(schema.bookConfigs)
    .where(eq(schema.bookConfigs.userId, userId));
  expect(config?.progress).toEqual([60, 120]);
  expect(config?.xpointer).toBe('/body/original');
});
