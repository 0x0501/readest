// Refuses a deploy whose .env.prod is incomplete.
//
// This runs on the local path and in CI, because the failure it prevents is
// silent from both. `wrangler deploy --secrets-file` uploads every key it finds,
// including empty ones, and a secret set to '' is not the same as an unset one:
// the code falls back with `??`, which catches undefined and not ''. So a
// half-filled file deploys a site that looks fine and is broken in ways that do
// not announce themselves as configuration problems.
import { readFileSync } from 'node:fs';

const FILE = '.env.prod';

// Why each one matters, printed with the error so the fix is obvious.
const REQUIRED = {
  NEXT_PUBLIC_WEB_BASE_URL:
    "Better Auth checks the Origin header against it. Wrong or unset, every sign-in returns 403 INVALID_ORIGIN while the rest of the site works.",
  NEXT_PUBLIC_API_BASE_URL: 'The host the client sends API requests to.',
  BETTER_AUTH_SECRET: 'Better Auth throws on the first request without it, so every route 500s.',
  SIGNUP_ALLOWED_EMAILS:
    'The admission gate. Empty admits nobody — on a fresh database you cannot create your own account.',
  R2_ACCOUNT_ID: 'R2 is reached over the S3 API, so it needs real credentials.',
  R2_ACCESS_KEY_ID: 'Without it the site reads fine and cannot upload a book.',
  R2_SECRET_ACCESS_KEY: 'Without it the site reads fine and cannot upload a book.',
  AUTH_EMAIL_FROM:
    'The sender for password-reset mail. Unset, the reset flow fails on send — the request looks accepted and no mail ever arrives.',
  TURNSTILE_SECRET_KEY:
    'The captcha plugin is registered only when this is set, so an unset value leaves sign-in, sign-up and reset unprotected while everything looks normal (ADR-017).',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY:
    'Without it the widget never renders, so the client sends no captcha token and every protected request is rejected.',
};

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch {
  console.error(`\n${FILE} is missing. Copy ${FILE}.example and fill it in.\n`);
  process.exit(1);
}

const values = new Map();
for (const line of raw.split('\n')) {
  const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (!match) continue;
  values.set(match[1], match[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
}

const missing = Object.keys(REQUIRED).filter((key) => !values.get(key));
// An empty optional key is worse than an absent one, for the `??` reason above.
const emptyOptional = [...values].filter(([key, v]) => !v && !REQUIRED[key]).map(([key]) => key);

if (missing.length === 0 && emptyOptional.length === 0) process.exit(0);

console.error(`\n${FILE} is not ready to deploy:\n`);
for (const key of missing) console.error(`  ${key} is not set\n    ${REQUIRED[key]}`);
for (const key of emptyOptional) {
  console.error(
    `  ${key} is empty — comment it out instead\n    wrangler uploads empty keys, and '' does not trigger the code's fallback.`,
  );
}
console.error('');
process.exit(1);
