import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';

const state = vi.hoisted(() => ({ rows: [] as unknown[][], dbError: false }));
const validateUser = vi.fn();
const signedUrl = vi.fn();
const planData = vi.fn();

vi.mock('@/utils/cors', () => ({
  corsAllMethods: {},
  runMiddleware: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUser(...args),
}));
vi.mock('@/utils/access', () => ({
  getStoragePlanData: (...args: unknown[]) => planData(...args),
  STORAGE_QUOTA_GRACE_BYTES: 0,
}));
vi.mock('@/utils/object', async (original) => ({
  ...(await original<typeof import('@/utils/object')>()),
  getUploadSignedUrl: (...args: unknown[]) => signedUrl(...args),
}));
vi.mock('@/libs/db', async (original) => {
  const { stubDb } = await import('../helpers/db-mock');
  return {
    ...(await original<typeof import('@/libs/db')>()),
    withDb: <T>(fn: (db: unknown) => Promise<T>) =>
      state.dbError ? Promise.reject(new Error('database unavailable')) : fn(stubDb(state.rows).db),
  };
});

import handler from '@/pages/api/storage/upload';

const QUOTA = 500 * 1024 * 1024;
const upload = async (fileSize: number) => {
  const req = {
    method: 'POST',
    headers: { authorization: 'Bearer token' },
    body: { fileName: 'Readest/Books/book.epub', fileSize },
  } as unknown as NextApiRequest;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as NextApiResponse;
  await handler(req, res);
  return res;
};

beforeEach(() => {
  state.rows = [];
  state.dbError = false;
  validateUser.mockReset().mockResolvedValue({ user: { id: 'user-1' }, token: 'token' });
  signedUrl.mockReset().mockResolvedValue('https://r2/upload');
  planData.mockReset().mockReturnValue({ usage: 0, quota: QUOTA });
});

describe('POST /api/storage/upload — live quota', () => {
  it('rejects an upload that exceeds live usage despite a stale zero JWT claim', async () => {
    state.rows = [[{ used: String(QUOTA) }]];
    const res = await upload(10 * 1024 * 1024);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Insufficient storage quota', usage: QUOTA });
    expect(signedUrl).not.toHaveBeenCalled();
  });

  it('reports live usage and accepts a genuinely fitting upload', async () => {
    state.rows = [[{ used: String(400 * 1024 * 1024) }], []];
    const res = await upload(10 * 1024 * 1024);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ usage: 410 * 1024 * 1024, quota: QUOTA }),
    );
    expect(signedUrl).toHaveBeenCalledOnce();
  });

  it('fails closed when live usage cannot be read', async () => {
    state.dbError = true;
    await expect(upload(1)).rejects.toThrow('database unavailable');
    expect(signedUrl).not.toHaveBeenCalled();
  });
});
