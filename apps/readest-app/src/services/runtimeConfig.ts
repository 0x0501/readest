export interface ReadestRuntimeConfig {
  githubSignIn?: boolean;
  turnstileSiteKey?: string;
  apiBaseUrl?: string;
  objectStorageType?: string;
  storageFixedQuota?: number;
  translationFixedQuota?: number;
}

declare global {
  interface Window {
    __READEST_RUNTIME_CONFIG?: ReadestRuntimeConfig;
  }
}

export const getRuntimeConfig = () =>
  typeof window === 'undefined' ? undefined : window.__READEST_RUNTIME_CONFIG;

export const getServerRuntimeConfig = (): ReadestRuntimeConfig => ({
  // Whether the sign-in page offers GitHub. It mirrors `githubProvider()` in
  // libs/auth/server.ts: a button for a provider the deployment has no
  // credentials for renders fine and can only fail on click.
  githubSignIn: Boolean(process.env['GITHUB_CLIENT_ID'] && process.env['GITHUB_CLIENT_SECRET']),
  // Public half of the Turnstile pair. Absent, the sign-in, sign-up and reset
  // forms render no widget and send no token — which is what local development
  // runs on, and mirrors the server registering the captcha plugin only when it
  // has a secret (ADR-017).
  turnstileSiteKey:
    process.env['TURNSTILE_SITE_KEY'] ?? process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY'],
  apiBaseUrl:
    process.env['API_BASE_URL'] ??
    process.env['NEXT_PUBLIC_API_BASE_URL'] ??
    process.env['SITE_URL'],
  // These were previously baked as NEXT_PUBLIC_* build args; now read from runtime env so
  // the published image can be configured without rebuilding.
  objectStorageType:
    process.env['OBJECT_STORAGE_TYPE'] ?? process.env['NEXT_PUBLIC_OBJECT_STORAGE_TYPE'],
  storageFixedQuota: (() => {
    const raw =
      process.env['STORAGE_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_STORAGE_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
  translationFixedQuota: (() => {
    const raw =
      process.env['TRANSLATION_FIXED_QUOTA'] ?? process.env['NEXT_PUBLIC_TRANSLATION_FIXED_QUOTA'];
    return raw ? parseInt(raw, 10) : undefined;
  })(),
});
