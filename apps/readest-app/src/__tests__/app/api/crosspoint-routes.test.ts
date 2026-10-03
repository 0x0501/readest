import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';

const validateUserAndTokenMock = vi.fn();
const getUserEmailMock = vi.fn();
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserAndTokenMock(...args),
  getUserEmail: (...args: unknown[]) => getUserEmailMock(...args),
}));

const getDownloadSignedUrlMock = vi.fn();
vi.mock('@/utils/object', () => ({
  getDownloadSignedUrl: (...args: unknown[]) => getDownloadSignedUrlMock(...args),
}));

vi.mock('@/libs/db', () => ({
  schema: {},
  withDb: (fn: (db: unknown) => unknown) => fn({}),
}));

const queries = vi.hoisted(() => ({
  purgeExpiredDeviceCodes: vi.fn(),
  insertDeviceCode: vi.fn(),
  approveDeviceCode: vi.fn(),
  claimApprovedDeviceCode: vi.fn(),
  findLiveDeviceCode: vi.fn(),
  insertCrosspointDevice: vi.fn(),
  restoreDeviceCode: vi.fn(),
  userIdForDeviceKeyHash: vi.fn(),
  revokeCrosspointDevice: vi.fn(),
  listUploadedEpubs: vi.fn(),
  liveFileKeys: vi.fn(),
  readBookConfig: vi.fn(),
  insertStatPages: vi.fn(),
  updateBookConfigProgress: vi.fn(),
  insertBookConfigProgress: vi.fn(),
  updateBookLibraryProgress: vi.fn(),
}));

vi.mock('@/libs/crosspointQueries', () => queries);

import { POST as codePOST } from '@/app/api/crosspoint/device/code/route';
import { POST as tokenPOST } from '@/app/api/crosspoint/device/token/route';
import { POST as approvePOST } from '@/app/api/crosspoint/device/approve/route';
import { GET as booksGET } from '@/app/api/crosspoint/books/route';
import { GET as bookGET } from '@/app/api/crosspoint/books/[hash]/route';
import { POST as sessionsPOST } from '@/app/api/crosspoint/sessions/route';
import { GET as authGET } from '@/app/api/crosspoint/users/auth/route';
import { GET as progressGET } from '@/app/api/crosspoint/syncs/progress/[document]/route';
import { PUT as progressPUT } from '@/app/api/crosspoint/syncs/progress/route';
import { DELETE as keyDELETE } from '@/app/api/crosspoint/keys/[id]/route';

const BASE = 'https://web.readest.com/api/crosspoint';
const NOW = '2026-10-02T00:00:00.000Z';
const USER = '11111111-2222-4333-8444-555555555555';
const EMAIL = 'reader@example.com';
const KEY = 'device-key';
const md5 = (value: string) => createHash('md5').update(value).digest('hex');
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const KEY_HASH = sha256(md5(KEY));
const DOC = '32bb20d7452627491831bb64a8d0dd94';
const XPOINTER = '/body/DocFragment[3]/body/p[12]/text().40';

const deviceHeaders = (auth: 'bearer' | 'kosync' | 'basic' = 'bearer'): Record<string, string> =>
  auth === 'bearer'
    ? { authorization: `Bearer ${KEY}` }
    : auth === 'kosync'
      ? { 'x-auth-user': EMAIL, 'x-auth-key': md5(KEY) }
      : { authorization: `Basic ${btoa(`${EMAIL}:${KEY}`)}` };

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
  vi.clearAllMocks();
  validateUserAndTokenMock.mockResolvedValue({});
  getUserEmailMock.mockResolvedValue(EMAIL);
  queries.userIdForDeviceKeyHash.mockResolvedValue(USER);
  queries.purgeExpiredDeviceCodes.mockResolvedValue(undefined);
  queries.insertDeviceCode.mockResolvedValue(undefined);
  queries.approveDeviceCode.mockResolvedValue(1);
  queries.claimApprovedDeviceCode.mockResolvedValue(null);
  queries.findLiveDeviceCode.mockResolvedValue(null);
  queries.insertCrosspointDevice.mockResolvedValue({ id: 'device-id' });
  queries.restoreDeviceCode.mockResolvedValue(undefined);
  queries.revokeCrosspointDevice.mockResolvedValue(undefined);
  queries.listUploadedEpubs.mockResolvedValue([]);
  queries.liveFileKeys.mockResolvedValue([]);
  queries.readBookConfig.mockResolvedValue(null);
  queries.insertStatPages.mockResolvedValue(undefined);
  queries.updateBookConfigProgress.mockResolvedValue(undefined);
  queries.insertBookConfigProgress.mockResolvedValue(undefined);
  queries.updateBookLibraryProgress.mockResolvedValue(undefined);
  getDownloadSignedUrlMock.mockResolvedValue('https://storage.example/signed');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('device sign-in', () => {
  const start = () => codePOST(new Request(`${BASE}/device/code`, { method: 'POST' }));

  it('starts a sign-in with a code to approve and a secret device code to poll with', async () => {
    const res = await start();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.device_code).toMatch(/^[0-9a-f]{64}$/);
    expect(body.user_code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
    expect(body).toMatchObject({
      verification_uri: 'https://web.readest.com/link',
      verification_uri_complete: `https://web.readest.com/link?code=${body.user_code}`,
      expires_in: 600,
      interval: 5,
    });
    expect(queries.purgeExpiredDeviceCodes).toHaveBeenCalledWith({}, NOW);
    expect(queries.insertDeviceCode).toHaveBeenCalledWith(
      {},
      {
        deviceCodeHash: sha256(body.device_code),
        userCode: body.user_code,
        expiresAt: '2026-10-02T00:10:00.000Z',
      },
    );

    queries.insertDeviceCode.mockRejectedValueOnce(new Error('boom'));
    expect((await start()).status).toBe(500);
  });

  it('lets the signed-in owner approve a code', async () => {
    const approve = (userCode: unknown) =>
      approvePOST(post('/device/approve', { user_code: userCode }));
    expect((await approve('BCDF-GHJK')).status).toBe(401);

    validateUserAndTokenMock.mockResolvedValue({ user: { id: USER }, token: 'jwt' });
    expect((await approve(' bcdf ghjk ')).status).toBe(200);
    expect(queries.approveDeviceCode).toHaveBeenCalledWith(
      {},
      { userCode: 'BCDF-GHJK', userId: USER, username: EMAIL, now: NOW },
    );

    queries.approveDeviceCode.mockResolvedValueOnce(0);
    expect((await approve('BCDF-GHJK')).status).toBe(404);
    queries.approveDeviceCode.mockRejectedValueOnce(new Error('boom'));
    expect((await approve('BCDF-GHJK')).status).toBe(500);

    queries.approveDeviceCode.mockClear();
    for (const code of ['hello', 'BCDF-GHJ', 'AAAA-AAAA', 42]) {
      expect((await approve(code)).status).toBe(400);
    }
    expect(queries.approveDeviceCode).not.toHaveBeenCalled();
  });

  it('answers polls with authorization_pending until the code is approved', async () => {
    queries.findLiveDeviceCode.mockResolvedValue({ expiresAt: '2026-10-02T00:05:00.000Z' });
    const res = await tokenPOST(post('/device/token', { device_code: 'abc' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'authorization_pending' });
    expect(queries.insertCrosspointDevice).not.toHaveBeenCalled();

    queries.findLiveDeviceCode.mockResolvedValue(null);
    const expired = await tokenPOST(post('/device/token', { device_code: 'abc' }));
    expect(await expired.json()).toEqual({ error: 'expired_token' });

    expect((await tokenPOST(post('/device/token', {}))).status).toBe(400);
    expect((await tokenPOST(post('/device/token', 'not json'))).status).toBe(400);
  });

  it('hands an approved reader its own key once, storing only the key hash', async () => {
    queries.claimApprovedDeviceCode.mockResolvedValue({
      userCode: 'BCDF-GHJK',
      userId: USER,
      username: EMAIL,
      expiresAt: '2026-10-02T00:05:00.000Z',
    });
    const res = await tokenPOST(post('/device/token', { device_code: 'abc' }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      access_token: expect.stringMatching(/^[0-9a-f]{64}$/),
      token_type: 'bearer',
      id: 'device-id',
      username: EMAIL,
    });
    expect(queries.claimApprovedDeviceCode).toHaveBeenCalledWith({}, sha256('abc'), NOW);
    expect(queries.insertCrosspointDevice).toHaveBeenCalledWith(
      {},
      USER,
      sha256(md5(body.access_token)),
    );
  });

  it('reports database failures while polling and puts a claimed approval back', async () => {
    const poll = () => tokenPOST(post('/device/token', { device_code: 'abc' }));
    queries.claimApprovedDeviceCode.mockRejectedValueOnce(new Error('boom'));
    expect((await poll()).status).toBe(500);

    queries.claimApprovedDeviceCode.mockResolvedValue(null);
    queries.findLiveDeviceCode.mockRejectedValueOnce(new Error('boom'));
    expect((await poll()).status).toBe(500);

    const approved = {
      userCode: 'BCDF-GHJK',
      userId: USER,
      username: EMAIL,
      expiresAt: '2026-10-02T00:05:00.000Z',
    };
    queries.claimApprovedDeviceCode.mockResolvedValue(approved);
    queries.insertCrosspointDevice.mockRejectedValueOnce(new Error('boom'));
    const res = await poll();
    expect(res.status).toBe(500);
    expect(await res.json()).not.toHaveProperty('access_token');
    expect(queries.restoreDeviceCode).toHaveBeenCalledWith(
      {},
      { deviceCodeHash: sha256('abc'), ...approved },
    );
  });

  it('revokes a device key by its id', async () => {
    const id = '99999999-8888-4777-8666-555555555555';
    const del = (keyId = id) =>
      keyDELETE(new Request(`${BASE}/keys/${keyId}`, { method: 'DELETE' }), {
        params: Promise.resolve({ id: keyId }),
      });
    const res = await del();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revoked: true });
    expect(queries.revokeCrosspointDevice).toHaveBeenCalledWith({}, id);
    expect((await del('x')).status).toBe(400);

    queries.revokeCrosspointDevice.mockRejectedValueOnce(new Error('boom'));
    expect((await del()).status).toBe(500);
  });
});

describe('device key authentication', () => {
  const check = (headers: Record<string, string>) =>
    authGET(new Request(`${BASE}/users/auth`, { headers }));

  it('accepts the key as a Bearer token, a KOSync key, or the HTTP Basic password', async () => {
    for (const auth of ['bearer', 'kosync', 'basic'] as const) {
      queries.userIdForDeviceKeyHash.mockClear();
      const res = await check(deviceHeaders(auth));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ authorized: 'OK' });
      expect(queries.userIdForDeviceKeyHash).toHaveBeenCalledWith({}, KEY_HASH);
    }
    expect((await check({ 'x-auth-key': md5(KEY).toUpperCase() })).status).toBe(200);
  });

  it('rejects unknown keys and malformed credentials', async () => {
    queries.userIdForDeviceKeyHash.mockResolvedValue(null);
    expect((await check(deviceHeaders())).status).toBe(401);

    const malformed: Record<string, string>[] = [
      {},
      { authorization: 'Token abc' },
      { authorization: 'Basic !!!' },
      { authorization: `Basic ${btoa('no-separator')}` },
    ];
    for (const headers of malformed) {
      queries.userIdForDeviceKeyHash.mockClear();
      expect((await check(headers)).status).toBe(401);
      expect(queries.userIdForDeviceKeyHash).not.toHaveBeenCalled();
    }
  });

  it('reports a failed key lookup as a server error, not a wrong key', async () => {
    queries.userIdForDeviceKeyHash.mockRejectedValue(new Error('boom'));
    expect((await check(deviceHeaders())).status).toBe(500);
  });
});

describe('library catalog', () => {
  const list = (query = '') =>
    booksGET(new Request(`${BASE}/books${query}`, { headers: deviceHeaders() }));

  it("pages the owner's uploaded EPUBs, most recently read first", async () => {
    queries.listUploadedEpubs.mockResolvedValue([
      { bookHash: DOC, title: 'Moby-Dick', author: 'Herman Melville' },
    ]);
    const res = await list('?page=2&per_page=8');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      items: [
        { id: DOC, title: 'Moby-Dick', author: 'Herman Melville', url: `${BASE}/books/${DOC}` },
      ],
    });
    expect(queries.listUploadedEpubs).toHaveBeenCalledWith(
      {},
      { userId: USER, offset: 8, limit: 9, q: '' },
    );
  });

  it('rejects readers without a valid key', async () => {
    queries.userIdForDeviceKeyHash.mockResolvedValue(null);
    expect((await list()).status).toBe(401);
    expect(queries.listUploadedEpubs).not.toHaveBeenCalled();
  });

  it('clamps paging input', async () => {
    for (const [query, offset, limit] of [
      ['', 0, 21],
      ['?page=0&per_page=500', 0, 51],
      ['?page=abc&per_page=-3', 0, 2],
      ['?page=2.7&per_page=8.9', 8, 9],
      ['?page=Infinity&per_page=8', 79992, 9],
    ] as const) {
      queries.listUploadedEpubs.mockClear();
      await list(query);
      expect(queries.listUploadedEpubs).toHaveBeenCalledWith(
        {},
        expect.objectContaining({ offset, limit }),
      );
    }
  });

  it('matches search text literally against title and author', async () => {
    await list(`?q=${encodeURIComponent(' Moby, (Dick) 100%_* ')}`);
    expect(queries.listUploadedEpubs).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ q: 'Moby Dick 100' }),
    );

    queries.listUploadedEpubs.mockClear();
    await list(`?q=${encodeURIComponent('(,)')}`);
    expect(queries.listUploadedEpubs).toHaveBeenCalledWith({}, expect.objectContaining({ q: '' }));
  });

  it('spells runs of dots in titles as an ellipsis the reader can save', async () => {
    queries.listUploadedEpubs.mockResolvedValue([
      { bookHash: DOC, title: 'Wait... What?', author: '' },
    ]);
    const { items } = await (await list()).json();
    expect(items[0].title).toBe('Wait… What?');
  });

  it('lists a book without a title under its hash', async () => {
    queries.listUploadedEpubs.mockResolvedValue([{ bookHash: DOC, title: null, author: null }]);
    const res = await list();
    expect(res.status).toBe(200);
    expect((await res.json()).items[0].title).toBe(DOC);
  });

  it('reports database failures', async () => {
    queries.listUploadedEpubs.mockRejectedValue(new Error('boom'));
    expect((await list()).status).toBe(500);
  });

  it('links a book download to its stored EPUB', async () => {
    const get = (hash = DOC) =>
      bookGET(new Request(`${BASE}/books/${hash}`, { headers: deviceHeaders() }), {
        params: Promise.resolve({ hash }),
      });
    queries.liveFileKeys.mockResolvedValue([
      { fileKey: `${USER}/Readest/Books/${DOC}/cover.png` },
      { fileKey: `${USER}/Readest/Books/${DOC}/Moby-Dick.epub` },
    ]);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ downloadUrl: 'https://storage.example/signed' });
    expect(getDownloadSignedUrlMock).toHaveBeenCalledWith(
      `${USER}/Readest/Books/${DOC}/Moby-Dick.epub`,
      1800,
    );
    expect(queries.liveFileKeys).toHaveBeenCalledWith({}, USER, DOC);

    queries.liveFileKeys.mockResolvedValue([{ fileKey: `${USER}/x/cover.png` }]);
    expect((await get()).status).toBe(404);
    expect((await get('not-a-hash')).status).toBe(400);
    queries.liveFileKeys.mockRejectedValue(new Error('boom'));
    expect((await get()).status).toBe(500);
    queries.userIdForDeviceKeyHash.mockResolvedValue(null);
    expect((await get()).status).toBe(401);
  });
});

describe('reading sessions', () => {
  const SESSION = { document: DOC, start_time: 1790000000, duration: 600, start_bp: 2500 };
  const session = (body: Record<string, unknown>) =>
    sessionsPOST(post('/sessions', { ...SESSION, end_bp: 3000, ...body }, deviceHeaders()));
  const inserted = () =>
    queries.insertStatPages.mock.calls.at(-1)?.[1] as
      | {
          page: number;
          duration: number;
          totalPages: number;
          bookHash: string;
          userId: string;
          startTime: number;
        }[]
      | undefined;

  it("spreads a session over the pages it covered, in the book's Readest page count", async () => {
    queries.readBookConfig.mockResolvedValue({ progress: '[30,120]' });
    const res = await session({});
    expect(res.status).toBe(200);
    const rows = inserted()!;
    expect(rows.map((row) => row.page)).toEqual([31, 32, 33, 34, 35, 36, 37]);
    expect(
      rows.every((row) => row.totalPages === 120 && row.bookHash === DOC && row.userId === USER),
    ).toBe(true);
    expect(rows[0]!.startTime).toBe(1790000000);
    rows.slice(1).forEach((row, index) => {
      expect(rows[index]!.startTime + rows[index]!.duration).toBe(row.startTime);
    });
    expect(rows.reduce((sum, row) => sum + row.duration, 0)).toBe(600);
    expect(queries.readBookConfig).toHaveBeenCalledWith({}, USER, DOC, false);
  });

  it('counts whole percents for a book Readest has not paginated', async () => {
    await session({});
    expect(inserted()!.map((row) => [row.page, row.duration, row.totalPages])).toEqual([
      [26, 100, 100],
      [27, 100, 100],
      [28, 100, 100],
      [29, 100, 100],
      [30, 100, 100],
      [31, 100, 100],
    ]);
  });

  it('keeps the pages a session ended on when it crossed more than it had time for', async () => {
    queries.readBookConfig.mockResolvedValue({ progress: '[30,120]' });
    await session({ duration: 12, start_bp: 0, end_bp: 5000 });
    expect(inserted()!.map((row) => [row.page, row.duration])).toEqual([
      [58, 3],
      [59, 3],
      [60, 3],
      [61, 3],
    ]);

    await session({ start_bp: 10000, end_bp: 10000 });
    expect(inserted()!.map((row) => row.page)).toEqual([120]);
  });

  it("drops sessions it can never record, so they don't stall the reader's queue", async () => {
    for (const body of [
      { document: 'not-a-hash' },
      { duration: 0 },
      { duration: 1.5 },
      { start_time: -1 },
      { end_bp: undefined },
    ]) {
      queries.insertStatPages.mockClear();
      const res = await session(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pages: 0 });
      expect(queries.insertStatPages).not.toHaveBeenCalled();
    }
    const garbled = await sessionsPOST(post('/sessions', 'not json', deviceHeaders()));
    expect(garbled.status).toBe(200);

    await session({ start_bp: 9950, end_bp: 10001 });
    expect(inserted()!.map((row) => row.page)).toEqual([100]);
  });

  it('leaves sessions for retry when the key is unknown', async () => {
    queries.userIdForDeviceKeyHash.mockResolvedValue(null);
    expect((await session({})).status).toBe(401);
    expect(queries.insertStatPages).not.toHaveBeenCalled();
  });

  it('reports database failures', async () => {
    queries.readBookConfig.mockRejectedValueOnce(new Error('boom'));
    expect((await session({})).status).toBe(500);
    expect(queries.insertStatPages).not.toHaveBeenCalled();

    queries.readBookConfig.mockResolvedValue(null);
    queries.insertStatPages.mockRejectedValueOnce(new Error('boom'));
    expect((await session({})).status).toBe(500);
  });
});

describe('KOSync progress', () => {
  const get = () =>
    progressGET(
      new Request(`${BASE}/syncs/progress/${DOC}`, { headers: deviceHeaders('kosync') }),
      {
        params: Promise.resolve({ document: DOC }),
      },
    );
  const put = (body: Record<string, unknown> | string, auth: 'kosync' | 'basic' = 'kosync') =>
    progressPUT(
      new Request(`${BASE}/syncs/progress`, {
        method: 'PUT',
        headers: deviceHeaders(auth),
        body:
          typeof body === 'string'
            ? body
            : JSON.stringify({ document: DOC, progress: XPOINTER, percentage: 0.5, ...body }),
      }),
    );

  it("returns the book's synced XPointer with its progress and time", async () => {
    queries.readBookConfig.mockResolvedValue({
      xpointer: XPOINTER,
      progress: '[30,120]',
      updatedAt: '2026-10-01T00:00:00.000Z',
    });
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      document: DOC,
      progress: XPOINTER,
      percentage: 0.25,
      device: 'Readest',
      device_id: 'readest',
      timestamp: 1790812800,
    });
    expect(queries.readBookConfig).toHaveBeenCalledWith({}, USER, DOC, true);
  });

  it('answers 404 without an XPointer, and 0% for an unusable page count', async () => {
    queries.readBookConfig.mockResolvedValue({
      xpointer: null,
      progress: '[30,120]',
      updatedAt: NOW,
    });
    expect((await get()).status).toBe(404);
    queries.readBookConfig.mockResolvedValue(null);
    expect((await get()).status).toBe(404);

    for (const progress of [null, 'not json', '[5,0]']) {
      queries.readBookConfig.mockResolvedValue({
        xpointer: XPOINTER,
        progress,
        updatedAt: '2026-10-01T00:00:00.000Z',
      });
      expect(await (await get()).json()).toMatchObject({ progress: XPOINTER, percentage: 0 });
    }
  });

  it("updates the book's config and library progress, never over a newer write", async () => {
    queries.readBookConfig.mockResolvedValue({
      xpointer: '/body/DocFragment[1]',
      progress: '[30,120]',
      updatedAt: '2026-09-01T00:00:00.000Z',
    });
    const res = await put({ device: 'CrossPoint' }, 'basic');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ document: DOC, timestamp: 1790899200 });
    expect(queries.updateBookConfigProgress).toHaveBeenCalledWith(
      {},
      {
        userId: USER,
        bookHash: DOC,
        xpointer: XPOINTER,
        progress: [60, 120],
        updatedAt: NOW,
      },
    );
    expect(queries.updateBookLibraryProgress).toHaveBeenCalledWith(
      {},
      {
        userId: USER,
        bookHash: DOC,
        progress: [60, 120],
        updatedAt: NOW,
      },
    );
  });

  it('keeps the percentage, in whole percents, for a book Readest has not paginated', async () => {
    await put({ percentage: 0.427 });
    expect(queries.insertBookConfigProgress).toHaveBeenCalledWith(
      {},
      {
        userId: USER,
        bookHash: DOC,
        xpointer: XPOINTER,
        progress: [43, 100],
        updatedAt: NOW,
      },
    );
    expect(queries.updateBookLibraryProgress).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ progress: [43, 100] }),
    );
  });

  it("doesn't pull Readest's position back for a reader that has not seen it", async () => {
    queries.readBookConfig.mockResolvedValue({
      xpointer: null,
      progress: '[60,120]',
      updatedAt: NOW,
    });
    expect((await put({ percentage: 0.01 })).status).toBe(200);
    expect(queries.updateBookConfigProgress).not.toHaveBeenCalled();
    expect(queries.insertBookConfigProgress).not.toHaveBeenCalled();
    expect(queries.updateBookLibraryProgress).not.toHaveBeenCalled();

    queries.readBookConfig.mockResolvedValue({
      xpointer: XPOINTER,
      progress: '[60,120]',
      updatedAt: NOW,
    });
    await put({ percentage: 0.01 });
    expect(queries.updateBookConfigProgress).toHaveBeenCalled();
  });

  it('rejects malformed pushes and unknown keys without writing', async () => {
    for (const body of [
      'not json',
      { document: 'not-a-hash' },
      { percentage: 1.5 },
      { percentage: undefined },
      { progress: '42' },
      { progress: `/body/${'p'.repeat(4096)}` },
    ]) {
      queries.readBookConfig.mockClear();
      expect((await put(body)).status).toBe(400);
      expect(queries.readBookConfig).not.toHaveBeenCalled();
    }

    queries.userIdForDeviceKeyHash.mockResolvedValue(null);
    expect((await put({})).status).toBe(401);
    expect(queries.readBookConfig).not.toHaveBeenCalled();
  });

  it('reports database failures, but a failed library row update never fails a push', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    queries.updateBookLibraryProgress.mockRejectedValueOnce(new Error('boom'));
    expect((await put({})).status).toBe(200);
    expect(warn).toHaveBeenCalled();

    queries.updateBookLibraryProgress.mockClear();
    queries.insertBookConfigProgress.mockRejectedValueOnce(new Error('boom'));
    expect((await put({})).status).toBe(500);
    expect(queries.updateBookLibraryProgress).not.toHaveBeenCalled();

    queries.readBookConfig.mockRejectedValue(new Error('boom'));
    expect((await put({})).status).toBe(500);
    expect((await get()).status).toBe(500);
    warn.mockRestore();
  });
});
