import { and, eq, gte, sql } from 'drizzle-orm';
import { type Db, schema } from '@/libs/db';

export const USAGE_TYPES = {
  TRANSLATION_CHARS: 'translation_chars',
} as const;

export const QUOTA_TYPES = {
  DAILY: 'daily',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
} as const;

/**
 * Quota windows are UTC days. Postgres resolves the date rather than the Worker
 * so the window does not depend on which machine asks.
 */
const utcToday = sql`(now() at time zone 'utc')::date`;
const utcMonthStart = sql`date_trunc('month', now() at time zone 'utc')::date`;

/**
 * Add to a counter and return its new value.
 *
 * Errors propagate. The previous implementation caught them and returned 0,
 * which is how it went unnoticed that the counter had no table behind it at all
 * (see `drizzle/local_003_usage_stats.sql`).
 */
export const trackUsage = async (
  db: Db,
  userId: string,
  usageType: string,
  increment: number = 1,
  metadata: Record<string, string | number> = {},
): Promise<number> => {
  const [row] = await db
    .insert(schema.usageStats)
    .values({ userId, usageType, usageDate: utcToday, usageCount: increment, metadata })
    .onConflictDoUpdate({
      target: [schema.usageStats.userId, schema.usageStats.usageType, schema.usageStats.usageDate],
      set: {
        usageCount: sql`${schema.usageStats.usageCount} + ${increment}`,
        metadata,
        updatedAt: sql`now()`,
      },
    })
    .returning({ usageCount: schema.usageStats.usageCount });

  return row?.usageCount ?? 0;
};

/**
 * Read a counter over the current day or month.
 *
 * Errors propagate here too, and deliberately: a quota check that cannot reach
 * the database must not answer "0 used".
 */
export const getCurrentUsage = async (
  db: Db,
  userId: string,
  usageType: string,
  period: 'daily' | 'monthly' = 'daily',
): Promise<number> => {
  const [row] = await db
    .select({ total: sql<number>`coalesce(sum(${schema.usageStats.usageCount}), 0)::int` })
    .from(schema.usageStats)
    .where(
      and(
        eq(schema.usageStats.userId, userId),
        eq(schema.usageStats.usageType, usageType),
        gte(schema.usageStats.usageDate, period === 'monthly' ? utcMonthStart : utcToday),
      ),
    );

  return row?.total ?? 0;
};
