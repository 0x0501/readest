import { createAuth } from '@/libs/auth/server';
import { withDb } from '@/libs/db';

// Better Auth's whole surface — sign-up, sign-in, OAuth callbacks, session, JWKS,
// token, API keys — is one catch-all handler.
//
// It is built per request rather than once at module scope because the database
// connection is: a Worker may not hold a socket open across requests, and the
// Hyperdrive connection string is only readable inside a request (see
// docs/database.md, ADR-004).
const handler = (request: Request) => withDb((db) => createAuth(db).handler(request));

export { handler as GET, handler as POST };
