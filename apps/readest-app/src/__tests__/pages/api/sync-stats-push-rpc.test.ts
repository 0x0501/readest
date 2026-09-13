import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';

const state = vi.hoisted(() => ({ calls: [] as { method: string; args: unknown[] }[] }));
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: async () => ({
    user: { id: '00000000-0000-0000-0000-000000000001' },
    token: 'tok',
  }),
}));
vi.mock('@/libs/db', async (original) => {
  const { stubDb } = await import('../../helpers/db-mock');
  return {
    ...(await original<typeof import('@/libs/db')>()),
    withDb: async <T>(fn: (db: unknown) => Promise<T>) => {
      const { db, calls } = stubDb();
      state.calls = calls;
      return fn(db);
    },
  };
});

import { POST } from '@/pages/api/sync';

const page = (start_time: number) => ({
  book_hash: 'h1',
  page: 3,
  start_time,
  duration: 5,
  total_pages: 100,
});
const post = (statPages: unknown[]) =>
  POST(
    new Request('https://web.readest.com/api/sync', {
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
      body: JSON.stringify({ statPages }),
    }) as unknown as NextRequest,
  );

beforeEach(() => {
  state.calls = [];
});

describe('POST /api/sync stat_pages push', () => {
  it('uses one database upsert RPC without a separate existing-row lookup', async () => {
    const response = await post([page(100), page(200)]);
    expect(response.status).toBe(200);
    expect(state.calls.filter((call) => call.method === 'execute')).toHaveLength(1);
    expect(state.calls.filter((call) => call.method === 'select')).toHaveLength(0);
    expect(JSON.stringify(state.calls.find((call) => call.method === 'execute')?.args)).toContain(
      'upsert_stat_pages_as',
    );
  });

  it('splits a large push into bounded 500-row calls', async () => {
    const response = await post(Array.from({ length: 1200 }, (_, index) => page(index)));
    expect(response.status).toBe(200);
    expect(state.calls.filter((call) => call.method === 'execute')).toHaveLength(3);
  });
});
