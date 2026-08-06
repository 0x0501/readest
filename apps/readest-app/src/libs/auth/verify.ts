import { eq } from 'drizzle-orm';
import { type JWTPayload, importJWK, jwtVerify } from 'jose';
import { type Db, schema, withDb } from '@/libs/db';
import { READEST_WEB_BASE_URL } from '@/services/constants';

/**
 * Better Auth signs access tokens with an Ed25519 key pair it keeps in the
 * `jwks` table, and stamps the key's row id into the token's `kid` header.
 *
 * Verifying against that table rather than against `/api/auth/jwks` keeps the
 * check inside the database connection the request already holds — a Worker
 * fetching its own HTTP endpoint would burn a subrequest, need the base URL to
 * resolve from inside the isolate, and fail closed on a cold cache.
 *
 * Issuer and audience are both Better Auth's `baseURL` (see
 * `plugins/jwt/sign.ts`), which is `READEST_WEB_BASE_URL` here. That is the
 * check that stops a token minted for another deployment from being accepted.
 */

const ALG = 'EdDSA';

export interface VerifiedUser {
  id: string;
}

/** The `kid` a Better Auth token carries, or null if this is not one. */
const readKeyId = (token: string): string | null => {
  const [header] = token.split('.');
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof decoded.kid === 'string' ? decoded.kid : null;
  } catch {
    return null;
  }
};

export const verifyAccessToken = async (
  db: Db,
  token: string,
): Promise<(JWTPayload & { sub: string }) | null> => {
  const kid = readKeyId(token);
  if (!kid) return null;

  const [key] = await db
    .select({ publicKey: schema.jwks.publicKey })
    .from(schema.jwks)
    .where(eq(schema.jwks.id, kid))
    .limit(1);
  if (!key) return null;

  try {
    const publicKey = await importJWK(JSON.parse(key.publicKey), ALG);
    const { payload } = await jwtVerify(token, publicKey, {
      issuer: READEST_WEB_BASE_URL,
      audience: READEST_WEB_BASE_URL,
    });
    return payload.sub ? (payload as JWTPayload & { sub: string }) : null;
  } catch {
    // Expired, tampered with, signed by a key this deployment does not hold,
    // or issued for a different base URL. None of them are distinguishable to
    // the caller, and none should be.
    return null;
  }
};

/**
 * The caller's email address.
 *
 * Deliberately not a token claim. `definePayload` keeps the JWT to the two
 * things every request needs (ADR-006), and the token is a bearer credential
 * the browser holds for a week — the fewer identifiers baked into it, the less
 * a leaked one says. The handful of routes that need an address ask for it.
 */
export const getUserEmail = async (db: Db, userId: string): Promise<string | null> => {
  const [row] = await db
    .select({ email: schema.user.email })
    .from(schema.user)
    .where(eq(schema.user.id, userId))
    .limit(1);
  return row?.email ?? null;
};

/**
 * Authenticate a request's `Authorization: Bearer …` header.
 *
 * Returns `{}` rather than throwing so callers keep the shape they had under
 * Supabase: `const { user, token } = await validateUserAndToken(db, header)`.
 */
export const validateUserAndToken = async (
  db: Db,
  authHeader: string | null | undefined,
): Promise<{ user?: VerifiedUser; token?: string }> => {
  if (!authHeader) return {};
  const token = authHeader.replace('Bearer ', '');
  const payload = await verifyAccessToken(db, token);
  if (!payload) return {};
  return { user: { id: payload.sub }, token };
};

/**
 * The same check for routes that touch no other table — AI chat and embedding,
 * Edge TTS, Yandex, metadata search, URL fetching.
 *
 * They hold a connection only for the JWKS lookup and give it back before the
 * work starts, which matters because that work is a streamed upstream response:
 * wrapping the handler in `withDb` would pin a Postgres connection open for as
 * long as a model takes to finish talking.
 */
export const validateRequestUser = async (
  authHeader: string | null | undefined,
): Promise<{ user?: VerifiedUser; token?: string }> => {
  if (!authHeader) return {};
  return withDb((db) => validateUserAndToken(db, authHeader));
};
