import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cf = vi.hoisted(() => ({ getCloudflareContext: vi.fn() }));
vi.mock('@opennextjs/cloudflare', () => ({ getCloudflareContext: cf.getCloudflareContext }));

const load = async () => (await import('@/libs/db')).getConnectionString;

beforeEach(() => {
  cf.getCloudflareContext.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('getConnectionString', () => {
  it('prefers the Hyperdrive binding when the Worker provides one', async () => {
    cf.getCloudflareContext.mockReturnValue({
      env: { HYPERDRIVE: { connectionString: 'postgresql://hyperdrive/local' } },
    });
    vi.stubEnv('DATABASE_URL', 'postgresql://direct/db');
    expect(await (await load())()).toBe('postgresql://hyperdrive/local');
  });

  it('falls back to DATABASE_URL outside the Worker runtime', async () => {
    // getCloudflareContext throws under vitest / next dev / drizzle-kit.
    cf.getCloudflareContext.mockImplementation(() => {
      throw new Error('not in a Worker');
    });
    vi.stubEnv('DATABASE_URL', 'postgresql://direct/db');
    expect(await (await load())()).toBe('postgresql://direct/db');
  });

  it('falls back to DATABASE_URL when the Worker has no Hyperdrive binding', async () => {
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv('DATABASE_URL', 'postgresql://direct/db');
    expect(await (await load())()).toBe('postgresql://direct/db');
  });

  // A deployment that starts against an unintended database is the failure mode
  // worth being loud about, so there is deliberately no default.
  it('throws when neither is configured', async () => {
    cf.getCloudflareContext.mockReturnValue({ env: {} });
    vi.stubEnv('DATABASE_URL', '');
    await expect(async () => (await load())()).rejects.toThrow(/HYPERDRIVE|DATABASE_URL/);
  });
});
