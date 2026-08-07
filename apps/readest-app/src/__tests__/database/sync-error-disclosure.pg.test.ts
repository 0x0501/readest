// @vitest-environment node
//
// What a failing sync tells the caller.
//
// Drizzle's error message is the statement plus every bound parameter, so
// forwarding `error.message` to the client hands out the column layout of the
// table and the row that was being written — user id, title, author, the whole
// metadata blob — to anyone who can make a write fail. It arrives in the
// browser console, where it is also picked up by any extension reading it.
//
// The failure is provoked with a session whose user row does not exist, which is
// a real foreign-key violation on the same insert the production report came
// from, rather than a stubbed throw.
import { randomUUID } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

let userId = '';

vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: userId }, token: 'tok' }),
}));

const { POST } = await import('@/pages/api/sync');

const TITLE = 'Autism: A Very Short Introduction';
const AUTHOR = 'Uta Frith';

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

let consoleError: ReturnType<typeof vi.spyOn>;
let consoleLog: ReturnType<typeof vi.spyOn>;

beforeAll(() => {
  // The route logs the failure server-side too; that is fine and not what this
  // file is about, but it should not drown the test output.
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterAll(() => {
  consoleError.mockRestore();
  consoleLog.mockRestore();
});

describe('a sync write that fails in the database', () => {
  it('reports the failure without disclosing the statement, the schema or the row', async () => {
    // No `user` row for this id, so the insert hits the foreign key.
    userId = randomUUID();

    const { status, body } = await push({
      books: [
        {
          hash: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
          format: 'EPUB',
          title: TITLE,
          author: AUTHOR,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    expect(status).toBe(500);

    const disclosed = JSON.stringify(body);
    // The statement and its bound values.
    expect(disclosed).not.toMatch(/insert into/i);
    expect(disclosed).not.toMatch(/\bparams:/i);
    expect(disclosed).not.toMatch(/\$\d/);
    // The column layout.
    expect(disclosed).not.toContain('book_hash');
    expect(disclosed).not.toContain('reading_status_updated_at');
    // The row itself.
    expect(disclosed).not.toContain(userId);
    expect(disclosed).not.toContain(TITLE);
    expect(disclosed).not.toContain(AUTHOR);
  });

  // Withholding the statement must not flatten every failure into one word.
  // The write stage is ours to name and says nothing about the schema, so it
  // survives the boundary — a `SyncError` is how a message declares it was
  // written for the caller rather than for the log.
  it('still names the stage that failed', async () => {
    userId = randomUUID();

    const { body } = await push({
      books: [
        {
          hash: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3',
          format: 'EPUB',
          title: TITLE,
          author: AUTHOR,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    });

    expect((body as { error: string }).error).toBe('Insert failed');
  });
});
