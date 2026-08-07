import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cf = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: cf.getCloudflareContext }));

const load = async () => import('@/libs/rateLimit');

beforeEach(() => {
  cf.getCloudflareContext.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

describe('clientIp', () => {
  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    const { clientIp } = await load();
    const headers = new Headers({
      'cf-connecting-ip': '203.0.113.9',
      'x-forwarded-for': '198.51.100.1, 198.51.100.2',
    });
    expect(clientIp(headers)).toBe('203.0.113.9');
  });

  it('falls back to the first x-forwarded-for hop', async () => {
    const { clientIp } = await load();
    const headers = new Headers({ 'x-forwarded-for': '198.51.100.1, 198.51.100.2' });
    expect(clientIp(headers)).toBe('198.51.100.1');
  });

  it('returns unknown when no address header is present', async () => {
    const { clientIp } = await load();
    expect(clientIp(new Headers())).toBe('unknown');
  });
});

describe('allowAuthRateLimit', () => {
  it('allows every request outside the Worker runtime', async () => {
    cf.getCloudflareContext.mockImplementation(() => {
      throw new Error('not in a Worker');
    });
    const { allowAuthRateLimit } = await load();
    expect(await allowAuthRateLimit('203.0.113.9')).toBe(true);
  });

  it('allows when the Worker has no binding', async () => {
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    const { allowAuthRateLimit } = await load();
    expect(await allowAuthRateLimit('203.0.113.9')).toBe(true);
  });

  it('returns false when the binding rejects the key', async () => {
    const limit = vi.fn().mockResolvedValue({ success: false });
    cf.getCloudflareContext.mockReturnValue({
      env: { AUTH_RATE_LIMITER: { limit } },
    });
    const { allowAuthRateLimit } = await load();
    expect(await allowAuthRateLimit('203.0.113.9')).toBe(false);
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.9' });
  });

  it('returns true when the binding accepts the key', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    cf.getCloudflareContext.mockReturnValue({
      env: { AUTH_RATE_LIMITER: { limit } },
    });
    const { allowAuthRateLimit } = await load();
    expect(await allowAuthRateLimit('203.0.113.9')).toBe(true);
  });

  it('does not collapse empty keys into a single shared bucket', async () => {
    const limit = vi.fn().mockResolvedValue({ success: true });
    cf.getCloudflareContext.mockReturnValue({
      env: { AUTH_RATE_LIMITER: { limit } },
    });
    const { allowAuthRateLimit } = await load();
    await allowAuthRateLimit('   ');
    expect(limit).toHaveBeenCalledWith({ key: 'unknown' });
  });
});

describe('rateLimitedResponse', () => {
  it('answers 429 with a Retry-After header', async () => {
    const { rateLimitedResponse } = await load();
    const res = rateLimitedResponse(30);
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('30');
    expect(await res.json()).toEqual({ error: 'Too many requests' });
  });
});
