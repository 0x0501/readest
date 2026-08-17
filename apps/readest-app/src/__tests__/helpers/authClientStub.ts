import { type Mock, vi } from 'vitest';

/**
 * Stands in for `@/libs/auth/client` across the whole unit lane, wired up as a
 * `resolve.alias` in `vitest.config.mts`.
 *
 * The real module calls `createAuthClient` at module scope, so merely importing
 * anything that reaches `AuthContext` — which most component tests do,
 * transitively — opens a BroadcastChannel and a nanostores session atom the test
 * never asked for. When that atom loses its last listener nanostores schedules
 * cleanup on a timer; if jsdom is torn down before the timer fires, Better
 * Auth's `cleanupBroadcastSetup` reads a `window` that no longer exists. Vitest
 * counts the uncaught exception as an unhandled error and fails the entire shard
 * while reporting every test as passed, so it reads as a phantom CI failure and
 * moves between shards whenever a test file is added or removed.
 *
 * Aliasing rather than mocking per file is deliberate: no unit test wants a real
 * cross-tab session client, and there were already sixteen files carrying the
 * hazard without naming it. Tests that assert on auth behaviour still declare
 * their own `vi.mock('@/libs/auth/client', …)`, which overrides this.
 */
// Annotated as `Mock` rather than left to inference: the inferred spy type
// names `Procedure` from @vitest/spy, which tsc cannot write down portably.
const resolved = (): Mock => vi.fn().mockResolvedValue({ data: null, error: null });

export const authClient = {
  useSession: () => ({ data: null, isPending: false, error: null, refetch: resolved() }),
  signOut: resolved(),
  changePassword: resolved(),
  resetPassword: resolved(),
  requestPasswordReset: resolved(),
  signIn: { email: resolved(), social: resolved(), passkey: resolved() },
  signUp: { email: resolved() },
  passkey: {
    addPasskey: resolved(),
    deletePasskey: resolved(),
    listUserPasskeys: vi.fn().mockResolvedValue({ data: [], error: null }) as Mock,
  },
};

export const mintAccessToken: Mock = vi.fn().mockResolvedValue(null);
