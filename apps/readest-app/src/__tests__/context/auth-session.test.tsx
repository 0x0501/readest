import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterAll, expect, test, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn<typeof fetch>());
const mintMock = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

// Exercise Better Auth's real session atom. A page reload starts it empty even
// when AuthProvider has a saved login, so an initial request failure must not
// erase that login. Only the HTTP boundary and JWT endpoint are stubbed.
vi.mock('@/libs/auth/client', async () => {
  const { createAuthClient } = await import('better-auth/react');
  return {
    authClient: createAuthClient({
      baseURL: 'http://localhost:3000',
      fetchOptions: { customFetchImpl: fetchMock },
    }),
    mintAccessToken: mintMock,
  };
});

import { AuthProvider, useAuth } from '@/context/AuthContext';
import { authClient } from '@/libs/auth/client';

let auth: ReturnType<typeof useAuth>;
function Probe() {
  auth = useAuth();
  return <span>{auth.user?.name ?? 'Signed out'}</span>;
}

afterAll(async () => {
  cleanup();
  localStorage.clear();
  // Nanostores delays listener cleanup by one second; let Better Auth detach
  // its browser listeners before Vitest tears down jsdom.
  await new Promise((resolve) => setTimeout(resolve, 1100));
});

test('survives a failed session check on reload, recovers, then honors session expiry', async () => {
  const user = { id: 'reader-1', name: 'Reader', email: 'reader@example.com' };
  localStorage.setItem('token', 'saved-jwt');
  localStorage.setItem('user', JSON.stringify(user));
  fetchMock.mockResolvedValue(Response.json({ message: 'Service unavailable' }, { status: 503 }));
  mintMock.mockResolvedValue('renewed-jwt');

  const view = render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(authClient.$store.atoms['session']!.get().error?.status).toBe(503));

  expect(view.getByText('Reader')).toBeTruthy();
  expect(localStorage.getItem('token')).toBe('saved-jwt');
  expect(mintMock).not.toHaveBeenCalled();

  fetchMock.mockResolvedValue(
    Response.json({
      session: { id: 'session-1', expiresAt: new Date(Date.now() + 86400_000).toISOString() },
      user,
    }),
  );
  await act(async () => {
    await authClient.$store.atoms['session']!.get().refetch();
  });
  await waitFor(() => expect(localStorage.getItem('token')).toBe('renewed-jwt'));
  expect(auth.user?.id).toBe(user.id);

  fetchMock.mockResolvedValue(Response.json(null));
  await act(async () => {
    await authClient.$store.atoms['session']!.get().refetch();
  });

  expect(view.getByText('Signed out')).toBeTruthy();
  expect(localStorage.getItem('token')).toBeNull();
  expect(localStorage.getItem('user')).toBeNull();
});
