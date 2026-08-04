import { getCloudflareContext } from '@opennextjs/cloudflare';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// Minimal local typing for the Hyperdrive binding (the project does not depend on
// @cloudflare/workers-types). Mirrors the pattern in
// `src/libs/payment/iap/telemetry.ts`.
interface Hyperdrive {
  connectionString: string;
}

interface CloudflareEnv {
  HYPERDRIVE?: Hyperdrive;
}

/**
 * Hyperdrive hands the Worker a local connection string that it proxies to the
 * real database, so nothing here is tied to a particular Postgres host (ADR-004).
 * Outside the Worker runtime — tests, `next dev`, drizzle-kit — connect directly.
 */
const getConnectionString = (): string => {
  try {
    const env = getCloudflareContext().env as Partial<CloudflareEnv> | undefined;
    if (env?.HYPERDRIVE) return env.HYPERDRIVE.connectionString;
  } catch {
    // getCloudflareContext throws outside the Worker runtime.
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('Neither the HYPERDRIVE binding nor DATABASE_URL is set.');
  return url;
};

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Open a connection for the duration of one request and close it afterwards.
 *
 * Workers may not hold a socket open across requests, and Hyperdrive already
 * pools on its side, so a single connection per request is both required and
 * cheap. Taking a callback rather than returning the connection means no caller
 * can forget to release it.
 */
export const withDb = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
  const pool = new Pool({ connectionString: getConnectionString(), max: 1 });
  try {
    return await fn(drizzle(pool, { schema }));
  } finally {
    await pool.end();
  }
};

export { schema };
