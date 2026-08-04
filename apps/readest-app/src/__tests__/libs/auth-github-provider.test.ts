import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/db', () => ({ schema: {} }));

const load = async () => (await import('@/libs/auth/server')).githubProvider;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// A provider registered without credentials renders a sign-in button that can
// only error, and Better Auth warns on every request that it has none.
describe('githubProvider', () => {
  it('registers GitHub when both credentials are set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');
    expect(await (await load())()).toEqual({ github: { clientId: 'id', clientSecret: 'secret' } });
  });

  it('registers nothing when neither is set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    expect(await (await load())()).toEqual({});
  });

  it('registers nothing when only one half is set', async () => {
    vi.stubEnv('GITHUB_CLIENT_ID', 'id');
    vi.stubEnv('GITHUB_CLIENT_SECRET', '');
    expect(await (await load())()).toEqual({});
    vi.resetModules();
    vi.stubEnv('GITHUB_CLIENT_ID', '');
    vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret');
    expect(await (await load())()).toEqual({});
  });
});
