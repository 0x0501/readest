import { passkeyClient } from '@better-auth/passkey/client';
import { createAuthClient } from 'better-auth/react';

/**
 * The browser half of Better Auth. No base URL: the catch-all handler is at
 * `/api/auth` on this same origin, so the session cookie is first-party and
 * there is no second host to keep in step with the server's `baseURL`.
 *
 * The passkey plugin is registered here rather than called through `$fetch`
 * because its endpoints are not plain requests — it has to run the WebAuthn
 * ceremony in the browser between them.
 */
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export type AuthUser = typeof authClient.$Infer.Session.user;

/**
 * Two credentials are in play and they are not interchangeable: the cookie
 * authenticates the browser to `/api/auth`, and this JWT is what every other API
 * route verifies against the JWKS (see docs/database.md, ADR-006).
 *
 * Called through `$fetch` rather than the `jwtClient` plugin. The plugin's only
 * action is `jwks`, which nothing here calls, and its return type is not
 * assignable to `BetterAuthClientPlugin` in 1.6.25 — which `tsc` rejects even
 * though the call works, so registering it would cost a broken build to buy
 * nothing. `AuthProvider` is the only caller.
 */
export const mintAccessToken = async (): Promise<string | null> => {
  const { data } = await authClient.$fetch<{ token: string }>('/token', { method: 'GET' });
  return data?.token ?? null;
};
