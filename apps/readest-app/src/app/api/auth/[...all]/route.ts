import { createAuth } from '@/libs/auth/server';
import { withDb } from '@/libs/db';
import { allowAuthRateLimit, clientIp, rateLimitedResponse } from '@/libs/rateLimit';

// Better Auth's whole surface — sign-up, sign-in, OAuth callbacks, session, JWKS,
// token, API keys — is one catch-all handler.
//
// It is built per request rather than once at module scope because the database
// connection is: a Worker may not hold a socket open across requests, and the
// Hyperdrive connection string is only readable inside a request (see
// docs/database.md, ADR-004).
//
// The Cloudflare rate limit runs before `withDb` so a flood never opens a
// Hyperdrive connection. Better Auth's own database-backed limiter (ADR-020)
// still applies inside the handler for path-specific rules.
const handler = async (request: Request) => {
  if (!(await allowAuthRateLimit(clientIp(request.headers)))) {
    return rateLimitedResponse();
  }
  return withDb((db) => createAuth(db).handler(request));
};

export { handler as GET, handler as POST };
