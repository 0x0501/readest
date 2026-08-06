// @vitest-environment node
//
// jose checks `instanceof Uint8Array`, and jsdom's TextEncoder returns one from
// a different realm — signing throws there for reasons that have nothing to do
// with this module. It only ever runs in the Worker anyway.
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { Db } from '@/libs/db';
import { validateRequestUser, validateUserAndToken, verifyAccessToken } from '@/libs/auth/verify';

// `validateRequestUser` is the only thing here that opens a connection; the rest
// take one as an argument.
const withDbMock = vi.hoisted(() => vi.fn());
vi.mock('@/libs/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/libs/db')>()),
  withDb: withDbMock,
}));

// `READEST_WEB_BASE_URL` falls back to this when NEXT_PUBLIC_WEB_BASE_URL is
// unset, which is the case under vitest.
const BASE_URL = 'https://web.readest.com';
const KEY_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

let privateKey: CryptoKey;
let publicJwk: string;

/**
 * Stands in for the one query `verifyAccessToken` makes. Returning `[]` for an
 * unknown id is what Drizzle does, so the "key was rotated away" path is
 * covered by the same stub.
 */
const stubDb = (keys: Record<string, string>) =>
  ({
    select: () => ({
      from: () => ({
        where: (condition: unknown) => ({
          limit: () => {
            // drizzle-orm renders `eq(col, value)` with the value in params.
            const requested = (condition as { queryChunks?: unknown[] })?.queryChunks?.find(
              (chunk): chunk is { value: string } =>
                typeof (chunk as { value?: unknown })?.value === 'string',
            )?.value;
            const publicKey = requested ? keys[requested] : undefined;
            return Promise.resolve(publicKey ? [{ publicKey }] : []);
          },
        }),
      }),
    }),
  }) as unknown as Db;

const signToken = async (
  claims: Record<string, unknown> = {},
  overrides: { kid?: string; issuer?: string; audience?: string; expiresIn?: string } = {},
) =>
  new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'EdDSA', kid: overrides.kid ?? KEY_ID })
    .setSubject(USER_ID)
    .setIssuer(overrides.issuer ?? BASE_URL)
    .setAudience(overrides.audience ?? BASE_URL)
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '7d')
    .sign(privateKey);

beforeAll(async () => {
  const pair = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  privateKey = pair.privateKey;
  publicJwk = JSON.stringify(await exportJWK(pair.publicKey));
});

describe('verifyAccessToken', () => {
  it('accepts a token signed by the key the jwks table holds', async () => {
    const token = await signToken({ plan: 'pro', storage_usage_bytes: 42 });
    const payload = await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), token);

    expect(payload?.sub).toBe(USER_ID);
    expect(payload?.['plan']).toBe('pro');
    expect(payload?.['storage_usage_bytes']).toBe(42);
  });

  it('rejects a token whose kid is not in the table', async () => {
    const token = await signToken({}, { kid: '33333333-3333-4333-8333-333333333333' });
    expect(await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), token)).toBeNull();
  });

  it('rejects a token signed by a different key', async () => {
    const other = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const foreign = JSON.stringify(await exportJWK(other.publicKey));
    const token = await signToken();

    expect(await verifyAccessToken(stubDb({ [KEY_ID]: foreign }), token)).toBeNull();
  });

  it('rejects a token issued for another deployment', async () => {
    const token = await signToken(
      {},
      { issuer: 'https://someone-else.example', audience: 'https://someone-else.example' },
    );
    expect(await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), token)).toBeNull();
  });

  it('rejects an expired token', async () => {
    const token = await signToken({}, { expiresIn: '-1s' });
    expect(await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), token)).toBeNull();
  });

  it('rejects a token with no kid header', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setSubject(USER_ID)
      .setIssuer(BASE_URL)
      .setAudience(BASE_URL)
      .setExpirationTime('7d')
      .sign(privateKey);

    expect(await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), token)).toBeNull();
  });

  it('rejects a value that is not a JWT at all', async () => {
    expect(await verifyAccessToken(stubDb({ [KEY_ID]: publicJwk }), 'not-a-token')).toBeNull();
  });
});

describe('validateUserAndToken', () => {
  it('returns the user id and the raw token for a valid header', async () => {
    const token = await signToken();
    const result = await validateUserAndToken(stubDb({ [KEY_ID]: publicJwk }), `Bearer ${token}`);

    expect(result.user?.id).toBe(USER_ID);
    expect(result.token).toBe(token);
  });

  it('returns nothing when the header is absent', async () => {
    expect(await validateUserAndToken(stubDb({}), null)).toEqual({});
  });

  it('returns nothing when the token does not verify', async () => {
    expect(await validateUserAndToken(stubDb({}), 'Bearer nope')).toEqual({});
  });
});

describe('validateRequestUser', () => {
  it('verifies against a connection it opens and gives back', async () => {
    const token = await signToken();
    withDbMock.mockImplementation((fn) => fn(stubDb({ [KEY_ID]: publicJwk })));

    const result = await validateRequestUser(`Bearer ${token}`);

    expect(result.user?.id).toBe(USER_ID);
    expect(withDbMock).toHaveBeenCalledOnce();
  });

  // The routes behind this helper are unauthenticated far more often than not —
  // any page load without a session hits them. Connecting first and finding no
  // header second would spend a Hyperdrive connection to learn nothing.
  it('does not connect when there is no header', async () => {
    withDbMock.mockClear();
    expect(await validateRequestUser(null)).toEqual({});
    expect(withDbMock).not.toHaveBeenCalled();
  });
});
