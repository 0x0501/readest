import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { NextApiRequest, NextApiResponse } from 'next';

// Hoisted mocks — defined before the route module is imported so vitest
// intercepts the imports inside the route.

const validateUserMock = vi.fn();
vi.mock('@/libs/auth/verify', () => ({
  validateUserAndToken: (...args: unknown[]) => validateUserMock(...args),
}));

const corsMock = vi.fn(async () => undefined);
vi.mock('@/utils/cors', () => ({
  corsAllMethods: vi.fn(),
  runMiddleware: corsMock,
}));

const putObjectMock = vi.fn();
const deleteObjectMock = vi.fn();
vi.mock('@/utils/object', () => ({
  putObject: (...args: unknown[]) => putObjectMock(...args),
  deleteObject: (...args: unknown[]) => deleteObjectMock(...args),
}));

const insertMock = vi.fn();
const updateMock = vi.fn();
const deleteMock = vi.fn();
const countMock = vi.fn();
// One stub per Drizzle chain the route builds. Spelling them out rather than
// reaching for the generic `stubDb` keeps the rollback assertions below able to
// say which statement ran.
vi.mock('@/libs/db', async (orig) => {
  const db = {
    select: () => ({ from: () => ({ where: () => countMock() }) }),
    insert: () => ({ values: (row: unknown) => ({ returning: () => insertMock(row) }) }),
    update: () => ({ set: (row: unknown) => ({ where: () => updateMock(row) }) }),
    delete: () => ({ where: () => deleteMock() }),
  };
  return {
    ...(await orig<typeof import('@/libs/db')>()),
    withDb: <T>(fn: (handle: unknown) => Promise<T>) => fn(db),
  };
});

// Import AFTER mocks are in place.
const { default: handler } = await import('@/pages/api/send/inbox/file');

interface MockRes {
  status: ReturnType<typeof vi.fn>;
  json: ReturnType<typeof vi.fn>;
  _status: number;
  _body: Record<string, unknown> | undefined;
}

function makeRes(): MockRes {
  const res: MockRes = {
    status: vi.fn(),
    json: vi.fn(),
    _status: 0,
    _body: undefined,
  };
  res.status.mockImplementation((code: number) => {
    res._status = code;
    return res as unknown as NextApiResponse;
  });
  res.json.mockImplementation((body: Record<string, unknown>) => {
    res._body = body;
    return res as unknown as NextApiResponse;
  });
  return res;
}

function makeReq(opts: {
  method?: string;
  authorization?: string;
  contentType?: string;
  title?: string;
  url?: string;
  body?: Buffer;
}): NextApiRequest {
  const emitter = new EventEmitter() as EventEmitter & {
    headers: Record<string, string>;
    method: string;
    destroy: () => void;
  };
  emitter.headers = {};
  if (opts.authorization) emitter.headers['authorization'] = opts.authorization;
  if (opts.contentType) emitter.headers['content-type'] = opts.contentType;
  if (opts.title) emitter.headers['x-readest-title'] = opts.title;
  if (opts.url) emitter.headers['x-readest-url'] = opts.url;
  emitter.method = opts.method ?? 'POST';
  emitter.destroy = vi.fn();

  // Emit body asynchronously so handler awaits the stream.
  setImmediate(() => {
    if (opts.body) emitter.emit('data', opts.body);
    emitter.emit('end');
  });

  return emitter as unknown as NextApiRequest;
}

const validUser = { id: 'user-123' };
const VALID_HEADERS = {
  authorization: 'Bearer abc',
  contentType: 'application/epub+zip',
};

beforeEach(() => {
  validateUserMock.mockReset().mockResolvedValue({ user: validUser });
  putObjectMock.mockReset().mockResolvedValue(undefined);
  deleteObjectMock.mockReset().mockResolvedValue(undefined);
  countMock.mockReset().mockResolvedValue([{ value: 0 }]);
  insertMock.mockReset().mockResolvedValue([{ id: 'inbox-1' }]);
  updateMock.mockReset().mockResolvedValue(undefined);
  deleteMock.mockReset().mockResolvedValue(undefined);
  corsMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('POST /api/send/inbox/file', () => {
  test('rejects unauthenticated requests with 403', async () => {
    validateUserMock.mockResolvedValueOnce({ user: null });
    const req = makeReq({ ...VALID_HEADERS, body: Buffer.from('PK\x03\x04...') });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(403);
  });

  test('rejects non-POST methods with 405', async () => {
    const req = makeReq({ method: 'GET', ...VALID_HEADERS });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(405);
  });

  test('rejects unsupported content-types with 415', async () => {
    const req = makeReq({
      authorization: 'Bearer abc',
      contentType: 'text/html',
      body: Buffer.from('<html/>'),
    });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(415);
  });

  test('rejects invalid source URL with 400', async () => {
    const req = makeReq({
      ...VALID_HEADERS,
      url: 'javascript:alert(1)',
      body: Buffer.from('PK\x03\x04'),
    });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });

  test('rejects when inbox is full with 429', async () => {
    countMock.mockResolvedValueOnce([{ value: 60 }]);
    const req = makeReq({ ...VALID_HEADERS, body: Buffer.from('PK\x03\x04') });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(429);
  });

  test('rejects empty file with 400', async () => {
    const req = makeReq({ ...VALID_HEADERS, body: Buffer.alloc(0) });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);
    expect(res._status).toBe(400);
  });

  test('stores the EPUB and returns the inbox row id on success', async () => {
    const body = Buffer.from('PK\x03\x04epub-bytes');
    const req = makeReq({
      ...VALID_HEADERS,
      url: 'https://example.com/article',
      title: "UTF-8''Article%20%E2%9C%85",
      body,
    });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({ id: 'inbox-1' });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const insertArg = insertMock.mock.calls[0]![0];
    expect(insertArg).toMatchObject({
      userId: validUser.id,
      kind: 'file',
      source: 'extension',
      url: 'https://example.com/article',
      filename: 'Article ✅',
      byteSize: body.byteLength,
    });

    expect(putObjectMock).toHaveBeenCalledTimes(1);
    expect(putObjectMock.mock.calls[0]![0]).toBe('inbox/user-123/inbox-1/clip.epub');
    expect(putObjectMock.mock.calls[0]![2]).toBe('application/epub+zip');

    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock.mock.calls[0]![0]).toEqual({
      payloadKey: 'inbox/user-123/inbox-1/clip.epub',
    });
  });

  test('rolls back the inbox row when R2 put fails', async () => {
    putObjectMock.mockRejectedValueOnce(new Error('R2 unavailable'));
    const req = makeReq({ ...VALID_HEADERS, body: Buffer.from('PK\x03\x04') });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).not.toHaveBeenCalled();
  });

  test('rolls back the inbox row and stored payload when payload_key update fails', async () => {
    updateMock.mockRejectedValueOnce(new Error('update failed'));
    const req = makeReq({ ...VALID_HEADERS, body: Buffer.from('PK\x03\x04') });
    const res = makeRes();
    await handler(req, res as unknown as NextApiResponse);

    expect(res._status).toBe(500);
    expect(deleteMock).toHaveBeenCalledTimes(1);
    expect(deleteObjectMock).toHaveBeenCalledWith(
      'inbox/user-123/inbox-1/clip.epub',
      expect.any(String),
    );
  });
});
