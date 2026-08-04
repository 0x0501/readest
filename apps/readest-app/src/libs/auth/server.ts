import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins/jwt';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { type Db, schema } from '@/libs/db';
import { READEST_WEB_BASE_URL } from '@/services/constants';

/**
 * Whether an address may register, against the comma-separated
 * `SIGNUP_ALLOWED_EMAILS`. This is the admission gate for the instance, which is
 * why email verification is not enabled — an address that is not on the list never
 * gets an account in the first place. An unset or empty list admits nobody.
 */
export const isSignupAllowed = (email: string): boolean =>
  (process.env['SIGNUP_ALLOWED_EMAILS'] ?? '')
    .split(',')
    .map((allowed) => allowed.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.trim().toLowerCase());

/**
 * Claims the client reads straight off the token: `utils/access.ts` decodes it
 * for every premium gate, and the profile page's storage bar reads the usage
 * (see docs/database.md, ADR-006). Both were previously produced by a Postgres
 * access-token hook.
 *
 * `plan` is fixed because this deployment has no billing tables and no checkout;
 * leaving it out would read as 'free' and lock features for everyone.
 */
const definePayload =
  (db: Db) =>
  async ({ user }: { user: { id: string } }) => {
    const [row] = await db
      .select({ used: sum(schema.files.fileSize) })
      .from(schema.files)
      .where(and(eq(schema.files.userId, user.id), isNull(schema.files.deletedAt)));
    return {
      plan: 'pro',
      storage_usage_bytes: Number(row?.used ?? 0),
    };
  };

/** The GitHub provider, or nothing when this deployment has not configured it. */
export const githubProvider = () => {
  const clientId = process.env['GITHUB_CLIENT_ID'];
  const clientSecret = process.env['GITHUB_CLIENT_SECRET'];
  return clientId && clientSecret ? { github: { clientId, clientSecret } } : {};
};

export const createAuth = (db: Db) =>
  betterAuth({
    appName: 'Readest',
    database: drizzleAdapter(db, { provider: 'pg', schema }),

    // Set explicitly rather than left to BETTER_AUTH_URL or to derivation from
    // request headers: this is what Better Auth checks the Origin header against,
    // so getting it wrong rejects every sign-in. It is the same per-deployment
    // origin the share links and public asset URLs already use.
    baseURL: READEST_WEB_BASE_URL,

    // Better Auth's default is a random text id. UUID keeps `public."user".id`
    // compatible with the twelve `user_id uuid` foreign keys upstream declares
    // and with the `${user.id}/${fileName}` object-storage key layout.
    advanced: { database: { generateId: 'uuid' } },

    emailAndPassword: { enabled: true },

    // GitHub is registered only when this deployment has actually configured it.
    // Registering it regardless would offer a sign-in button that can only fail,
    // and Better Auth warns on every request that it has no credentials.
    socialProviders: githubProvider(),

    plugins: [
      // Bearer tokens for the API surface. Session cookies still authenticate the
      // browser — the JWT plugin does not replace them — but every server route
      // validates `Authorization: Bearer <token>` against the JWKS.
      jwt({
        jwt: {
          // The app's getAccessToken() reads localStorage and has no refresh loop
          // of its own, so the 15-minute default would strand a reader mid-session.
          expirationTime: '7d',
          definePayload: definePayload(db),
        },
      }),
      // Long-lived device tokens for KOReader, which is paired by pasting a token
      // rather than by typing a password on an e-ink screen. The browser extension
      // keeps capturing credentials from the web app instead (see docs/database.md,
      // ADR-011).
      apiKey(),
    ],

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isSignupAllowed(user.email)) {
              throw new Error('This instance is invite-only.');
            }
            return { data: user };
          },
        },
      },
    },
  });
