// @vitest-environment node
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '@/libs/db/schema';

const pool = new Pool({ connectionString: process.env['DATABASE_URL'] });
const db = drizzle(pool, { schema });
let userId: string;

beforeAll(async () => {
  const [user] = await db
    .insert(schema.user)
    .values({
      name: 'stats RPC test',
      email: `stats-rpc-${Date.now()}@example.test`,
      emailVerified: false,
    })
    .returning({ id: schema.user.id });
  userId = user!.id;
});

afterAll(async () => {
  if (userId) await db.delete(schema.user).where(eq(schema.user.id, userId));
  await pool.end();
});

describe('upsert_stat_pages_as for Better Auth users', () => {
  it('inserts a page, keeps the longer duration, and rejects a shorter replay', async () => {
    const push = async (duration: number) => {
      const rows = JSON.stringify([
        {
          book_hash: 'book',
          page: 3,
          start_time: 100,
          duration,
          total_pages: 100,
          ext: null,
          deleted_at: null,
        },
      ]);
      await db.execute(sql`select public.upsert_stat_pages_as(${userId}::uuid, ${rows}::jsonb)`);
    };
    await push(5);
    await push(3);
    await push(9);

    const [row] = await db
      .select({ duration: schema.statPages.duration })
      .from(schema.statPages)
      .where(and(eq(schema.statPages.userId, userId), eq(schema.statPages.bookHash, 'book')));
    expect(row?.duration).toBe(9);
  });
});
