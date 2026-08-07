// @vitest-environment node
//
// An annotation carries two separate pieces of the reader's writing: `text`,
// the passage they selected, and `note`, what they wrote about it. A device
// that receives the first and not the second shows a highlight with nothing
// attached — which reads as the note having been lost rather than never having
// arrived, and there is no error anywhere to say otherwise.
//
// Pushed and pulled back over real HTTP against a real database, because the
// hazard is in the column mapping and the wire encoding, and a mocked query
// would agree with whatever the code does.
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NextRequest } from 'next/server';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as schema from '@/libs/db/schema';

let userId = '';

vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: userId }, token: 'tok' }),
}));

const { GET, POST } = await import('@/pages/api/sync');

const connectionString = process.env['DATABASE_URL']!;
let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;

const BOOK_HASH = 'note-roundtrip-book';
const QUOTE = '更难能可贵的是，她是一位充满同理心的女性。';
const NOTE = '测试记录笔记';

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

const annotation = (id: string, updatedAt: number, note: string) => ({
  bookHash: BOOK_HASH,
  id,
  type: 'annotation',
  cfi: 'epubcfi(/6/8!/4/6,/1:73,/1:165)',
  xpointer0: '/body/DocFragment[4]/body/p[2]/text().73',
  xpointer1: '/body/DocFragment[4]/body/p[2]/text().165',
  text: QUOTE,
  style: 'highlight',
  color: 'yellow',
  note,
  page: 8,
  createdAt: updatedAt,
  updatedAt,
});

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });
  userId = randomUUID();
  await db.insert(schema.user).values({
    id: userId,
    name: 'note roundtrip',
    email: `note-${userId}@example.test`,
    emailVerified: false,
    updatedAt: new Date().toISOString(),
  });
});

afterAll(async () => {
  await db.delete(schema.user).where(eq(schema.user.id, userId));
  await pool.end();
});

describe('an annotation with a note', () => {
  it('survives a push and comes back on a pull', async () => {
    const at = Date.now();

    const pushed = await push({ notes: [annotation('note-1', at, NOTE)] });
    expect(pushed.status).toBe(200);

    const pulled = (await pull(`type=notes&since=0`)) as { notes?: Array<Record<string, unknown>> };
    const row = pulled.notes?.find((n) => n['id'] === 'note-1');

    expect(row).toBeDefined();
    expect(row!['text']).toBe(QUOTE);
    // The half that goes missing on the receiving device when it goes missing.
    expect(row!['note']).toBe(NOTE);
  });

  // The reader highlights first and writes afterwards, so the second push is an
  // update to a row the server already has. A merge that kept the older row
  // would leave every other device showing the highlight without the note.
  it('is still there when the note is added after the highlight', async () => {
    const created = Date.now();

    await push({ notes: [annotation('note-2', created, '')] });
    const withNote = await push({ notes: [annotation('note-2', created + 12_000, NOTE)] });
    expect(withNote.status).toBe(200);

    const pulled = (await pull(`type=notes&since=0`)) as { notes?: Array<Record<string, unknown>> };
    const row = pulled.notes?.find((n) => n['id'] === 'note-2');

    expect(row!['note']).toBe(NOTE);
  });
});
