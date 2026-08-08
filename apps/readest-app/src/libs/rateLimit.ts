import { getCloudflareContext } from '@opennextjs/cloudflare';

/**
 * Cloudflare Rate Limiting for `/api/auth/*` (see wrangler.toml `[[ratelimits]]`).
 *
 * Runs before the auth handler opens a Hyperdrive connection. The call is
 * non-blocking — no network hop. Outside the Worker runtime (`next dev`,
 * vitest) there is no binding and the check is a no-op.
 *
 * This is the only auth rate limit in production (ADR-021). Better Auth's
 * limiter is disabled.
 */

interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface CloudflareEnv {
  AUTH_RATE_LIMITER?: RateLimit;
}

const getBinding = (): RateLimit | undefined => {
  try {
    const env = getCloudflareContext().env as Partial<CloudflareEnv> | undefined;
    return env?.AUTH_RATE_LIMITER;
  } catch {
    // getCloudflareContext throws outside the Worker runtime.
    return undefined;
  }
};

/**
 * Prefer the address Cloudflare saw. `x-forwarded-for` is only a fallback for
 * local reverse proxies; on the edge `cf-connecting-ip` is the one that cannot
 * be spoofed by the client.
 */
export const clientIp = (headers: Headers): string => {
  const cf = headers.get('cf-connecting-ip')?.trim();
  if (cf) return cf;
  const forwarded = headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  if (forwarded) return forwarded;
  return 'unknown';
};

/**
 * Returns true when the request is within budget (or when no binding is
 * available — local dev / tests). False means the caller should answer 429.
 */
export const allowAuthRateLimit = async (key: string): Promise<boolean> => {
  const binding = getBinding();
  if (!binding) return true;
  const safeKey = key.trim() || 'unknown';
  const { success } = await binding.limit({ key: safeKey });
  return success;
};

export const rateLimitedResponse = (retryAfterSeconds = 60): Response =>
  new Response(JSON.stringify({ error: 'Too many requests' }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(retryAfterSeconds),
    },
  });
