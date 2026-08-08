# Readest (self-hosted fork)

A fork of the Readest ebook reader, deployed as a single-operator instance on
Cloudflare Workers. Most of the vocabulary here is upstream's; this file records
only the terms where this deployment means something different, or where two
nearby terms have been confused for each other.

## Language

### Identity and access

**Allow-list**:
The set of email addresses that may hold an account on this instance, from
`SIGNUP_ALLOWED_EMAILS`. It governs both who may register and who may
authenticate — one list, two jobs, deliberately not split.
_Avoid_: whitelist, invite list, allowed users

**Self-hosted deployment**:
This instance. Not the Readest app or service published by the upstream
project, and not affiliated with it.
_Avoid_: official version, production Readest

**Password reset**:
Recovering access when the password is unknown. Proved by possession of the
mailbox: a link is mailed, its token verified, and a new password written.
_Avoid_: recovery, forgot password (as a name for the mechanism), magic link

**Change password**:
Replacing a known password with another while signed in. Proved by knowing the
current one; sends no mail. A different flow from **password reset**, with a
different precondition — the two are not interchangeable.
_Avoid_: reset (as a name for this), update password

**Magic link**:
A Better Auth mechanism that mints a *session* from a mailed token. Not used
here, and not a synonym for the link used in **password reset** — that one
authorizes a password write and creates no session.

**Passkey**:
A WebAuthn credential held by a device, used as an alternative to the password.
Web platform only; the Tauri builds cannot present one.
_Avoid_: biometric login, Face ID login, security key

**Captcha token**:
A single-use Turnstile token attached to a sign-in, sign-up or reset request.
Spent on first verification, so a retry needs a fresh one.
_Avoid_: challenge, captcha response

**Auth rate limit**:
The Cloudflare `AUTH_RATE_LIMITER` binding on `/api/auth/*` only, keyed by
client IP, evaluated before any database work. Better Auth's own rate limiter is
disabled on this deployment (ADR-021). It is not Postgres, not Hyperdrive, and
not a storage or translation ceiling.
_Avoid_: throttle, quota (those mean storage/translation plan ceilings), Better
Auth rate limit (as a name for what we run in production)

**Session cookie cache**:
A short-lived, signed cookie that holds a Better Auth session snapshot so
`get-session` can answer without opening the database. Max age is ten minutes
(ADR-022). Not a substitute for the session token cookie; not Hyperdrive query
caching.
_Avoid_: JWT, access token, session cookie (the signed session *token* is
separate), HTTP cache
