import { apiKey } from '@better-auth/api-key';
import { passkey } from '@better-auth/passkey';
import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware } from 'better-auth/api';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { captcha } from 'better-auth/plugins';
import { jwt } from 'better-auth/plugins/jwt';
import { and, eq, isNull, sum } from 'drizzle-orm';
// The passkey plugin puts @simplewebauthn types in this module's inferred exports,
// and pnpm's isolated layout leaves them unnameable from here without a direct
// reference — `createAuth` then fails to typecheck with TS2883.
import type {} from '@simplewebauthn/server';
import { type Db, schema } from '@/libs/db';
import { READEST_WEB_BASE_URL } from '@/services/constants';
import { createMailer, type SendMail } from './mail';

/**
 * Whether an address may hold an account here, against the comma-separated
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
 * The body fields Better Auth carries an address in. Every endpoint uses `email`
 * except `/change-email`, which uses `newEmail` — and that is the one that would
 * otherwise let an invited account move itself to an address that never was.
 */
const EMAIL_FIELDS = ['email', 'newEmail'] as const;

const INVITE_ONLY = 'This instance is invite-only — that address is not on the list.';

/**
 * Reject an uninvited address at the request boundary, before any route handler
 * runs (ADR-017).
 *
 * The `databaseHooks` check below is not enough on its own: it fires after Better
 * Auth has parsed the body, hashed the password and queried for an existing user,
 * so every uninvited attempt paid for the most expensive step in the request. It
 * still has a job the middleware cannot do — a social callback carries no address
 * in its body — so both exist, and neither covers the other.
 *
 * Keying on the field rather than on a list of paths means an endpoint added by a
 * future Better Auth release inherits this without anyone remembering to add it.
 */
const allowListGate = createAuthMiddleware(async (ctx) => {
  const body = ctx.body as Record<string, unknown> | undefined;
  for (const field of EMAIL_FIELDS) {
    const value = body?.[field];
    if (typeof value === 'string' && !isSignupAllowed(value)) {
      throw new APIError('FORBIDDEN', { message: INVITE_ONLY, code: 'EMAIL_NOT_ALLOWED' });
    }
  }
});

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

/** The host passkeys and captcha tokens are bound to. */
const siteHostname = () => new URL(READEST_WEB_BASE_URL).hostname;

/**
 * Turnstile in front of sign-in, sign-up and password reset — which are exactly
 * the plugin's default endpoints, so no list is configured here.
 *
 * Registered only when a secret is configured, so local development runs without
 * production credentials. The cost of that is a deployment which forgets the key
 * being unprotected while looking entirely normal, which is why `check-env-prod`
 * treats it as required (ADR-017).
 */
const captchaPlugins = () => {
  const secretKey = process.env['TURNSTILE_SECRET_KEY'];
  if (!secretKey) return [];
  return [
    captcha({
      provider: 'cloudflare-turnstile',
      secretKey,
      // A token minted for another site on the same key verifies fine otherwise.
      allowedHostnames: [siteHostname()],
    }),
  ];
};

const resetPasswordMail = (url: string) => ({
  subject: 'Reset your Readest password',
  text: [
    'Someone asked to reset the password on your Readest account.',
    '',
    `Open this link to choose a new one: ${url}`,
    '',
    'The link is good for one hour and can be used once. If this was not you,',
    'nothing has changed and you can ignore this message.',
  ].join('\n'),
  html: [
    '<p>Someone asked to reset the password on your Readest account.</p>',
    `<p><a href="${url}">Choose a new password</a></p>`,
    '<p>The link is good for one hour and can be used once. If this was not you,',
    'nothing has changed and you can ignore this message.</p>',
  ].join('\n'),
});

/**
 * `sendMail` is injectable so that the auth surface can be driven over HTTP in a
 * test without a Worker or a mail account. Left out, it resolves the Cloudflare
 * binding for this request (ADR-016).
 */
export const createAuth = (db: Db, { sendMail }: { sendMail?: SendMail } = {}) => {
  const mail = sendMail ?? createMailer();

  return betterAuth({
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

    emailAndPassword: {
      enabled: true,
      // Recovery for an instance with one account and no operator to call
      // (ADR-016). Better Auth mails `${baseURL}/reset-password/${token}`, which
      // verifies the token itself and redirects to the page named in
      // `redirectTo` with a validated one — so the page never sees an unchecked
      // token, and no session is created along the way.
      sendResetPassword: async ({ user, url }) => {
        await mail({ to: user.email, ...resetPasswordMail(url) });
      },
    },

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
      // A credential the phone can present, so signing in there is a glance rather
      // than a long password on a soft keyboard. The rpID is what every enrolled
      // credential is bound to and cannot be changed afterwards (ADR-018).
      passkey({
        rpID: process.env['PASSKEY_RP_ID'] || siteHostname(),
        rpName: 'Readest',
      }),
      ...captchaPlugins(),
    ],

    hooks: { before: allowListGate },

    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            if (!isSignupAllowed(user.email)) {
              // An APIError, not a plain one: Better Auth wraps anything else as
              // a bare `Failed to create user`, so the sign-up form told a
              // blocked address nothing it could act on.
              throw new APIError('FORBIDDEN', {
                message: INVITE_ONLY,
                code: 'SIGNUP_NOT_ALLOWED',
              });
            }
            return { data: user };
          },
        },
      },
    },
  });
};
