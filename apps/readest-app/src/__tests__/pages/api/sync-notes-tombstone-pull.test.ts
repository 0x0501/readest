import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ rows: [] as unknown[][] }));
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({ user: { id: 'u1' }, token: 'tok' }),
}));
vi.mock('@/libs/db', async (original) => {
  const { stubDb } = await import('../../helpers/db-mock');
  return {
    ...(await original<typeof import('@/libs/db')>()),
    withDb: <T>(fn: (db: unknown) => Promise<T>) => fn(stubDb(state.rows).db),
  };
});

import { GET } from '@/pages/api/sync';

beforeEach(() => {
  state.rows = [];
});

describe('GET /api/sync?type=notes with duplicate note IDs', () => {
  it('returns the tombstone over a newer live duplicate', async () => {
    const live = {
      book_hash: 'r',
      id: 'n1',
      updated_at: new Date(3000).toISOString(),
      deleted_at: null,
    };
    const tombstone = {
      book_hash: 'k',
      id: 'n1',
      updated_at: new Date(1000).toISOString(),
      deleted_at: new Date(5000).toISOString(),
    };
    state.rows = [[live, tombstone]];
    const request = new Request(
      'https://web.readest.com/api/sync?since=2000&type=notes&book=r&meta_hash=m1',
      { headers: { authorization: 'Bearer tok' } },
    ) as unknown as NextRequest;

    const response = await GET(request);
    expect((await response.json()).notes).toEqual([tombstone]);
  });
});
