import { jwtClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';

/**
 * The browser half of Better Auth. No base URL: the catch-all handler is at
 * `/api/auth` on this same origin, so the session cookie is first-party and
 * there is no second host to keep in step with the server's `baseURL`.
 *
 * `jwtClient` is what puts `authClient.token()` on here. Two credentials are in
 * play and they are not interchangeable — the cookie authenticates the browser
 * to `/api/auth`, and the JWT it mints is what every other API route verifies
 * against the JWKS (see docs/database.md, ADR-006). `AuthProvider` is the only
 * place that calls it.
 */
export const authClient = createAuthClient({ plugins: [jwtClient()] });

export type AuthUser = typeof authClient.$Infer.Session.user;
