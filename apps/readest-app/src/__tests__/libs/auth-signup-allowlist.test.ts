import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/libs/db', () => ({ schema: {} }));

const loadAuth = async () => (await import('@/libs/auth/server')).createAuth;

const load = async () => (await import('@/libs/auth/server')).isSignupAllowed;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

// Better Auth turns a plain Error thrown from a database hook into a bare
// "Failed to create user", so a blocked address learned nothing about why. The
// reason has to survive as far as the sign-up form.
describe('the invite-only rejection', () => {
  it('reaches the caller as a message they can act on', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'reader@example.com');
    const auth = (await loadAuth())({} as never);
    const beforeCreate = auth.options.databaseHooks?.user?.create?.before;

    await expect(beforeCreate?.({ email: 'intruder@example.com' } as never)).rejects.toThrow(
      /invite-only/,
    );
  });

  it('lets a listed address through untouched', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'reader@example.com');
    const auth = (await loadAuth())({} as never);
    const beforeCreate = auth.options.databaseHooks?.user?.create?.before;
    const user = { email: 'reader@example.com' };

    await expect(beforeCreate?.(user as never)).resolves.toEqual({ data: user });
  });
});

// The allowlist is the instance's admission gate — email verification is off
// because this is what keeps strangers out. A permissive edge here is an open
// registration endpoint, not a cosmetic bug.
describe('isSignupAllowed', () => {
  it('admits a listed address', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'reader@example.com');
    expect((await load())('reader@example.com')).toBe(true);
  });

  it('rejects an unlisted address', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'reader@example.com');
    expect((await load())('intruder@example.com')).toBe(false);
  });

  it('admits nobody when the list is unset or empty', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', '');
    expect((await load())('reader@example.com')).toBe(false);
    expect((await load())('')).toBe(false);
  });

  it('ignores surrounding whitespace and empty entries', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', ' one@example.com , , two@example.com ');
    const allowed = await load();
    expect(allowed('one@example.com')).toBe(true);
    expect(allowed('two@example.com')).toBe(true);
    expect(allowed('')).toBe(false);
  });

  it('compares case-insensitively on both sides', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'Reader@Example.COM');
    expect((await load())('reader@example.com')).toBe(true);
    expect((await load())('READER@EXAMPLE.COM')).toBe(true);
  });

  it('does not admit a mere substring or suffix of a listed address', async () => {
    vi.stubEnv('SIGNUP_ALLOWED_EMAILS', 'reader@example.com');
    const allowed = await load();
    expect(allowed('evil-reader@example.com')).toBe(false);
    expect(allowed('reader@example.com.evil.test')).toBe(false);
    expect(allowed('example.com')).toBe(false);
  });
});
