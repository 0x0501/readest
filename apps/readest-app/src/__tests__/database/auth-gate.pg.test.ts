// @vitest-environment node
//
// The auth surface driven the way a browser drives it: real Requests through
// `auth.handler`, against a real database. Nothing here mocks Better Auth,
// because the failures worth catching are ones where it keeps answering and the
// security property quietly does not hold.
//
// Two of those are specific enough to name. The allow-list is enforced by a
// request-boundary hook keyed on body fields (ADR-017), so an endpoint that
// carries the address under a different name — `/change-email` uses `newEmail` —
// is not covered by anything the endpoint list would have caught. And Better
// Auth's Drizzle adapter drops a WHERE condition whose column it cannot find
// rather than raising, so a reset token has to be shown to actually stop working
// after it is spent.
import { drizzle } from 'drizzle-orm/node-postgres';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAuth } from '@/libs/auth/server';
import type { MailMessage } from '@/libs/auth/mail';
import * as schema from '@/libs/db/schema';

const connectionString = process.env['DATABASE_URL']!;
const ORIGIN = process.env['NEXT_PUBLIC_WEB_BASE_URL'] ?? 'http://localhost:3000';

const INVITED = `invited-${Date.now()}@example.test`;
const UNINVITED = `stranger-${Date.now()}@example.test`;
const PASSWORD = 'correct horse battery staple';

let pool: Pool;
let db: ReturnType<typeof drizzle<typeof schema>>;
let sent: MailMessage[];

const auth = () => createAuth(db, { sendMail: async (message) => void sent.push(message) });

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  auth().handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    }),
  );

beforeAll(async () => {
  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  sent = [];
  await db.delete(schema.user).where(eq(schema.user.email, INVITED));
  await db.delete(schema.user).where(eq(schema.user.email, UNINVITED));
  vi.stubEnv('SIGNUP_ALLOWED_EMAILS', INVITED);
  // Absent by default: the captcha plugin is registered only when a secret is
  // configured, which is what lets development run without one.
  vi.stubEnv('TURNSTILE_SECRET_KEY', '');
});

const signUp = (email: string) =>
  post('/sign-up/email', { email, password: PASSWORD, name: 'Test' });

describe('allow-list at the request boundary', () => {
  it('lets an invited address sign up and sign in', async () => {
    expect((await signUp(INVITED)).status).toBe(200);
    const signIn = await post('/sign-in/email', { email: INVITED, password: PASSWORD });
    expect(signIn.status).toBe(200);
  });

  it('refuses an uninvited sign-up, and creates no user', async () => {
    const response = await signUp(UNINVITED);

    expect(response.status).toBe(403);
    expect(await response.clone().json()).toMatchObject({ code: 'EMAIL_NOT_ALLOWED' });
    const rows = await db.select().from(schema.user).where(eq(schema.user.email, UNINVITED));
    expect(rows).toHaveLength(0);
  });

  // The point of the boundary hook over the user-creation hook: the address is
  // turned away before the request pays for a password hash.
  it('refuses an uninvited sign-in', async () => {
    const response = await post('/sign-in/email', { email: UNINVITED, password: PASSWORD });
    expect(response.status).toBe(403);
  });

  it('refuses an uninvited password-reset request, and sends nothing', async () => {
    const response = await post('/request-password-reset', {
      email: UNINVITED,
      redirectTo: `${ORIGIN}/auth/reset-password`,
    });

    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });

  // `/change-email` carries the address as `newEmail`. An allow-list that only
  // looked at `email` would let an invited account move itself off the list.
  it('refuses a change-email to an address that is not on the list', async () => {
    await signUp(INVITED);
    const response = await post('/change-email', { newEmail: UNINVITED });
    expect(response.status).toBe(403);
  });

  it('says the instance is invite-only rather than failing anonymously', async () => {
    const body = await (await signUp(UNINVITED)).json();
    expect(body.message).toContain('invite-only');
  });
});

describe('password reset', () => {
  const request = () =>
    post('/request-password-reset', {
      email: INVITED,
      redirectTo: `${ORIGIN}/auth/reset-password`,
    });

  const tokenFromMail = () => {
    const url = sent.at(-1)!.text.match(/https?:\/\/\S+/)![0];
    return new URL(url).pathname.split('/').pop()!;
  };

  beforeEach(async () => {
    await signUp(INVITED);
    sent = [];
  });

  it('mails a link to an invited address', async () => {
    expect((await request()).status).toBe(200);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(INVITED);
    expect(sent[0]!.text).toContain('/reset-password/');
  });

  it('sets the new password, which then signs in', async () => {
    await request();

    const reset = await post('/reset-password', {
      newPassword: 'a different password entirely',
      token: tokenFromMail(),
    });
    expect(reset.status).toBe(200);

    const withNew = await post('/sign-in/email', {
      email: INVITED,
      password: 'a different password entirely',
    });
    expect(withNew.status).toBe(200);
    const withOld = await post('/sign-in/email', { email: INVITED, password: PASSWORD });
    expect(withOld.status).not.toBe(200);
  });

  it('refuses to spend the same token twice', async () => {
    await request();
    const token = tokenFromMail();
    await post('/reset-password', { newPassword: 'first replacement', token });

    const second = await post('/reset-password', { newPassword: 'second replacement', token });
    expect(second.status).not.toBe(200);
  });

  it('refuses a token that was not issued', async () => {
    const response = await post('/reset-password', {
      newPassword: 'whatever',
      token: 'not-a-real-token',
    });
    expect(response.status).not.toBe(200);
  });
});

describe('captcha', () => {
  it('rejects a protected request when configured and no token is supplied', async () => {
    vi.stubEnv('TURNSTILE_SECRET_KEY', 'test-secret');

    const response = await post('/sign-in/email', { email: INVITED, password: PASSWORD });

    expect(response.status).toBe(400);
  });
});
