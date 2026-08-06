'use client';

import posthog from 'posthog-js';
import {
  createContext,
  useState,
  useContext,
  useCallback,
  useMemo,
  ReactNode,
  useEffect,
} from 'react';
import { type AuthUser, authClient } from '@/libs/auth/client';

interface AuthContextType {
  token: string | null;
  user: AuthUser | null;
  logout: () => void;
  refresh: () => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const storedUser = (): AuthUser | null => {
  if (typeof window === 'undefined') return null;
  const json = localStorage.getItem('user');
  return json ? (JSON.parse(json) as AuthUser) : null;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { data: session, isPending } = authClient.useSession();
  const [token, setToken] = useState<string | null>(() =>
    typeof window === 'undefined' ? null : localStorage.getItem('token'),
  );
  const [user, setUser] = useState<AuthUser | null>(storedUser);

  // localStorage is the app's actual view of who is signed in: `getAccessToken`
  // reads it on every API call and `getUserID` wherever a row is scoped. The
  // React state here is the copy that re-renders, and it is seeded from the same
  // place so a reload does not blank the UI while the session request is in
  // flight.
  const store = useCallback((nextToken: string | null, nextUser: AuthUser | null) => {
    if (nextToken && nextUser) {
      localStorage.setItem('token', nextToken);
      localStorage.setItem('user', JSON.stringify(nextUser));
      posthog.identify(nextUser.id);
    } else {
      localStorage.removeItem('token');
      localStorage.removeItem('user');
    }
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  // The cookie is the session. The JWT is a derivative of it that API routes
  // verify against the JWKS, so it is minted whenever the session changes and
  // dropped the moment it does not. `useSession` returns a stable object from
  // its nanostore, so this does not re-run on unrelated renders.
  useEffect(() => {
    if (isPending) return;
    if (!session) {
      store(null, null);
      return;
    }
    let active = true;
    authClient.token().then(({ data }) => {
      if (active && data?.token) store(data.token, session.user);
    });
    return () => {
      active = false;
    };
  }, [isPending, session, store]);

  const logout = useCallback(async () => {
    // Clear locally first: signOut is a round trip, and every gated screen reads
    // `token` synchronously.
    store(null, null);
    await authClient.signOut();
  }, [store]);

  // Claims go stale in place — `storage_usage_bytes` is baked into the token, so
  // deleting a book leaves the quota bar reading the old figure until a fresh
  // one is minted. Only the token changes; the user did not.
  const refresh = useCallback(async () => {
    const { data } = await authClient.token();
    if (!data?.token) return;
    localStorage.setItem('token', data.token);
    setToken(data.token);
  }, []);

  const value = useMemo(() => ({ token, user, logout, refresh }), [token, user, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};

export const useAuth = (): AuthContextType => {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
};
