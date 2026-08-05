// @vitest-environment node
//
// The load-bearing claim of `withUserContext`: seven of upstream's RPCs scope
// their own writes with `auth.uid()`, PostgREST used to supply that claim, and
// now the caller does. If the session variable is not set, or leaks between
// requests, those RPCs either do nothing or touch the wrong user's rows — and
// nothing else in the suite would notice. ADR-005 asks every data path for a
// "user A cannot reach user B" test; this is that test for the RPC seam.
import { eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '@/libs/db/schema';
import { withUserContext } from '@/libs/db/rpc';

const connectionString = process.env['DATABASE_URL']!;

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let alice: string;
let bob: string;

const makeUser = async (label: string) => {
  const [row] = await db
    .insert(schema.user)
    .values({
      name: label,
      email: `${label}-${Date.now()}@example.test`,
      emailVerified: false,
    })
    .returning({ id: schema.user.id });
  return row!.id;
};

const claimAs = (userId: string, device: string) =>
  withUserContext(db, userId, (tx) =>
    tx.execute(sql`select * from public.claim_inbox_item(${device})`),
  );

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });
  alice = await makeUser('alice');
  bob = await makeUser('bob');
});

afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, alice));
  await db.delete(schema.user).where(eq(schema.user.id, bob));
  await pool.end();
});

beforeEach(async () => {
  await db.delete(schema.sendInbox).where(eq(schema.sendInbox.userId, alice));
  await db.delete(schema.sendInbox).where(eq(schema.sendInbox.userId, bob));
  await db.insert(schema.sendInbox).values({
    userId: alice,
    kind: 'file',
    source: 'email',
    filename: 'book.epub',
    byteSize: 1234,
  });
});

describe('withUserContext + claim_inbox_item', () => {
  it('claims the caller"s own pending item', async () => {
    const result = await claimAs(alice, 'alice-laptop');

    expect(result.rows[0]?.['id']).toBeTruthy();
    expect(result.rows[0]?.['status']).toBe('claimed');
    expect(result.rows[0]?.['claimed_by']).toBe('alice-laptop');
  });

  it('does not reach another user"s item', async () => {
    const result = await claimAs(bob, 'bob-phone');

    // The RPC returns a NULL-filled row when it finds nothing claimable.
    expect(result.rows[0]?.['id']).toBeFalsy();

    const [row] = await db
      .select({ status: schema.sendInbox.status })
      .from(schema.sendInbox)
      .where(eq(schema.sendInbox.userId, alice));
    expect(row?.status).toBe('pending');
  });

  it('does not leave the claim set for the next statement on the connection', async () => {
    await claimAs(alice, 'alice-laptop');

    // set_config(..., true) is transaction-local, so this reads NULL rather
    // than alice — the guarantee that stops a pooled connection carrying one
    // request's identity into the next.
    const after = await db.execute(sql`select auth.uid() as uid`);
    expect(after.rows[0]?.['uid']).toBeNull();
  });
});
