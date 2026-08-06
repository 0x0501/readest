import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const useSessionMock = vi.hoisted(() => vi.fn());
const tokenMock = vi.hoisted(() => vi.fn());
const signOutMock = vi.hoisted(() => vi.fn());

vi.mock('@/libs/auth/client', () => ({
  authClient: {
    useSession: useSessionMock,
    token: tokenMock,
    signOut: signOutMock,
  },
}));

vi.mock('posthog-js', () => ({
  default: { identify: vi.fn() },
}));

import { AuthProvider, useAuth } from '@/context/AuthContext';

const SESSION = {
  session: { id: 'session-1' },
  user: { id: 'user-1', email: 'reader@example.com', name: 'A Reader' },
};

const captured: ReturnType<typeof useAuth>[] = [];

function Probe() {
  captured.push(useAuth());
  return null;
}

function Wrapper({ tick }: { tick: number }) {
  // The tick prop forces a parent re-render but does not change AuthProvider state
  return (
    <AuthProvider>
      <span data-tick={tick} />
      <Probe />
    </AuthProvider>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    captured.length = 0;
    window.localStorage.clear();
    useSessionMock.mockReturnValue({ data: null, isPending: false });
    tokenMock.mockResolvedValue({ data: { token: 'jwt-abc' } });
    signOutMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  // getAccessToken() and getUserID() read localStorage rather than this context,
  // so a session that never reaches localStorage leaves every API call
  // unauthenticated while the UI looks signed in.
  test('mints a token for the session and writes both to localStorage', async () => {
    useSessionMock.mockReturnValue({ data: SESSION, isPending: false });

    render(<Wrapper tick={0} />);

    await waitFor(() => {
      expect(window.localStorage.getItem('token')).toBe('jwt-abc');
    });
    expect(JSON.parse(window.localStorage.getItem('user')!).id).toBe('user-1');
  });

  test('clears both when the session is gone', async () => {
    window.localStorage.setItem('token', 'stale');
    window.localStorage.setItem('user', JSON.stringify(SESSION.user));

    render(<Wrapper tick={0} />);

    await waitFor(() => {
      expect(window.localStorage.getItem('token')).toBeNull();
    });
    expect(window.localStorage.getItem('user')).toBeNull();
  });

  // Between mount and the first session response there is a window where the
  // session is unknown. Signing the user out during it would log everyone out on
  // every reload.
  test('leaves storage alone while the session is still loading', async () => {
    window.localStorage.setItem('token', 'jwt-from-last-time');
    window.localStorage.setItem('user', JSON.stringify(SESSION.user));
    useSessionMock.mockReturnValue({ data: null, isPending: true });

    render(<Wrapper tick={0} />);

    expect(window.localStorage.getItem('token')).toBe('jwt-from-last-time');
    expect(captured.at(-1)!.token).toBe('jwt-from-last-time');
  });

  test('refresh re-mints the token without touching the user', async () => {
    useSessionMock.mockReturnValue({ data: SESSION, isPending: false });
    render(<Wrapper tick={0} />);
    await waitFor(() => expect(window.localStorage.getItem('token')).toBe('jwt-abc'));

    tokenMock.mockResolvedValue({ data: { token: 'jwt-fresh' } });
    await captured.at(-1)!.refresh();

    expect(window.localStorage.getItem('token')).toBe('jwt-fresh');
    expect(JSON.parse(window.localStorage.getItem('user')!).id).toBe('user-1');
  });

  // Every gated screen reads `token` synchronously, so waiting on the round trip
  // would leave them rendering as signed in.
  test('logout clears before it calls signOut', async () => {
    useSessionMock.mockReturnValue({ data: SESSION, isPending: false });
    render(<Wrapper tick={0} />);
    await waitFor(() => expect(window.localStorage.getItem('token')).toBe('jwt-abc'));

    let clearedBeforeCall = false;
    signOutMock.mockImplementation(async () => {
      clearedBeforeCall = window.localStorage.getItem('token') === null;
    });
    await captured.at(-1)!.logout();

    expect(clearedBeforeCall).toBe(true);
  });

  test('returns the same context value reference when parent re-renders without state change', () => {
    const { rerender } = render(<Wrapper tick={0} />);
    rerender(<Wrapper tick={1} />);
    rerender(<Wrapper tick={2} />);

    // If logout/refresh are not stable (no useCallback), useMemo's deps change
    // every render and produce a fresh object each time — this catches that.
    expect(captured.at(-1)).toBe(captured.at(-2));
  });

  test('logout/refresh callbacks are stable across re-renders', () => {
    const { rerender } = render(<Wrapper tick={0} />);
    rerender(<Wrapper tick={1} />);

    expect(captured.at(-1)!.logout).toBe(captured.at(-2)!.logout);
    expect(captured.at(-1)!.refresh).toBe(captured.at(-2)!.refresh);
  });
});
