// @vitest-environment node
//
// Runs against a real Postgres (ADR-012). Excluded from the unit lane by the
// `*.pg.test.ts` suffix; `pnpm test:pg` runs it with DATABASE_URL pointed at a
// database the migration chain has been applied to.
//
// The test this replaces asserted the arguments handed to a mocked
// `supabase.rpc('increment_daily_usage', …)`. It passed for as long as the
// function did not exist — which was always. Counting is the only assertion
// worth making here.
import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/libs/db/schema';
import { USAGE_TYPES, getCurrentUsage, trackUsage } from '@/utils/usage';

const connectionString = process.env['DATABASE_URL']!;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let userId: string;

const TYPE = USAGE_TYPES.TRANSLATION_CHARS;

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });

  const [row] = await db
    .insert(schema.user)
    .values({
      name: 'usage test',
      email: `usage-${Date.now()}@example.test`,
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
  await db.delete(schema.usageStats).where(eq(schema.usageStats.userId, userId));
});

describe('trackUsage', () => {
  it('creates a row for today and returns the new total', async () => {
    await expect(trackUsage(db, userId, TYPE, 120)).resolves.toBe(120);
  });

  it('accumulates within the same day rather than overwriting', async () => {
    await trackUsage(db, userId, TYPE, 120);
    await trackUsage(db, userId, TYPE, 30);

    await expect(trackUsage(db, userId, TYPE, 1)).resolves.toBe(151);
  });

  it('keeps counters for different usage types apart', async () => {
    await trackUsage(db, userId, TYPE, 120);
    await trackUsage(db, userId, 'other_thing', 7);

    await expect(getCurrentUsage(db, userId, TYPE)).resolves.toBe(120);
    await expect(getCurrentUsage(db, userId, 'other_thing')).resolves.toBe(7);
  });

  it('records the metadata of the most recent call', async () => {
    await trackUsage(db, userId, TYPE, 1, { plan_type: 'free', source: 'deepl_api' });
    await trackUsage(db, userId, TYPE, 1, { plan_type: 'pro', source: 'deepl_api' });

    const [row] = await db
      .select({ metadata: schema.usageStats.metadata })
      .from(schema.usageStats)
      .where(and(eq(schema.usageStats.userId, userId), eq(schema.usageStats.usageType, TYPE)));

    expect(row?.metadata).toEqual({ plan_type: 'pro', source: 'deepl_api' });
  });
});

describe('getCurrentUsage', () => {
  it('is zero for a user who has used nothing', async () => {
    await expect(getCurrentUsage(db, userId, TYPE)).resolves.toBe(0);
  });

  it('counts only today for the daily window', async () => {
    await trackUsage(db, userId, TYPE, 50);
    await db.insert(schema.usageStats).values({
      userId,
      usageType: TYPE,
      usageDate: sql`((now() at time zone 'utc') - interval '1 day')::date`,
      usageCount: 900,
    });

    await expect(getCurrentUsage(db, userId, TYPE, 'daily')).resolves.toBe(50);
  });

  it('sums the whole month for the monthly window', async () => {
    await trackUsage(db, userId, TYPE, 50);
    // The first of the current month: earlier than today for all but one day a
    // month, when it *is* today — hence the upsert, so the row either appears
    // alongside the one above or merges into it. Either way the month totals
    // the same, which is what the window is being asked.
    await db.execute(sql`
      insert into usage_stats (user_id, usage_type, usage_date, usage_count)
      values (${userId}, ${TYPE}, date_trunc('month', now() at time zone 'utc')::date, 900)
      on conflict (user_id, usage_type, usage_date)
        do update set usage_count = usage_stats.usage_count + excluded.usage_count
    `);

    await expect(getCurrentUsage(db, userId, TYPE, 'monthly')).resolves.toBe(950);
    // ...and the daily window still sees only today's 50, unless today is the
    // first, in which case the two rows are one.
    const daily = await getCurrentUsage(db, userId, TYPE, 'daily');
    expect([50, 950]).toContain(daily);
  });
});
