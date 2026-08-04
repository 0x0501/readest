import { apiKey } from '@better-auth/api-key';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { jwt } from 'better-auth/plugins/jwt';
import { and, eq, isNull, sum } from 'drizzle-orm';
import { type Db, schema, withDb } from '@/libs/db';

/**
 * Emails allowed to register, comma-separated. This is the admission gate for the
 * instance, which is why email verification is not enabled — an address that is
 * not on the list never gets an account in the first place.
 */
const allowedSignupEmails = (): string[] =>
  (process.env['SIGNUP_ALLOWED_EMAILS'] ?? '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean);

/**
 * Claims the client reads straight off the token: `utils/access.ts` decodes it
 * for every premium gate, and the profile page's storage bar reads the usage
 * (ADR-006). Both were previously produced by a Postgres access-token hook.
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

export const createAuth = (db: Db) =>
  betterAuth({
    appName: 'Readest',
    database: drizzleAdapter(db, { provider: 'pg', schema }),

    // Better Auth's default is a random text id. UUID keeps `public."user".id`
    // compatible with the twelve `user_id uuid` foreign keys upstream declares
    // and with the `${user.id}/${fileName}` object-storage key layout.
    advanced: { database: { generateId: 'uuid' } },

    emailAndPassword: { enabled: true },

    socialProviders: {
      github: {
        clientId: process.env['GITHUB_CLIENT_ID'] ?? '',
        clientSecret: process.env['GITHUB_CLIENT_SECRET'] ?? '',
      },
    },

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
      // Long-lived device tokens for KOReader and the browser extension, neither
      // of which has a browser to run an OAuth flow in (ADR-011).
      apiKey(),
    ],

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            const allowed = allowedSignupEmails();
            if (!allowed.includes(user.email.toLowerCase())) {
              throw new Error('This instance is invite-only.');
            }
            return { data: user };
          },
        },
      },
    },
  });

/** Run one request against a connection that is closed when it finishes. */
export const withAuth = <T>(fn: (auth: ReturnType<typeof createAuth>) => Promise<T>): Promise<T> =>
  withDb((db) => fn(createAuth(db)));
