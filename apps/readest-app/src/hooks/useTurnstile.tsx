import { Turnstile, type TurnstileInstance } from '@marsidev/react-turnstile';
import { useCallback, useRef, useState } from 'react';
import { getRuntimeConfig } from '@/services/runtimeConfig';

/**
 * The Turnstile widget for a form that posts to a captcha-protected Better Auth
 * endpoint — sign-in, sign-up and password reset.
 *
 * Absent a site key there is no widget, no header, and nothing blocking submit:
 * the server registers the captcha plugin only when it has a secret, so an
 * unconfigured deployment has to work end to end without one. That is what local
 * development runs on.
 *
 * `reset` exists because a token is spent on its first verification. A form that
 * stays on the page after a rejected submit is holding a token the server will
 * refuse, so the next attempt fails on the captcha rather than on the password —
 * which looks like the password being wrong twice.
 */
export const useTurnstile = () => {
  // The runtime-config route only exists in the web build; the Tauri build is
  // statically exported and reads the value baked in at build time instead
  // (see the note in app/layout.tsx).
  const siteKey =
    getRuntimeConfig()?.turnstileSiteKey ?? process.env['NEXT_PUBLIC_TURNSTILE_SITE_KEY'];
  const instance = useRef<TurnstileInstance>(null);
  const [token, setToken] = useState('');

  const reset = useCallback(() => {
    if (!siteKey) return;
    setToken('');
    instance.current?.reset();
  }, [siteKey]);

  return {
    /** Attach to the Better Auth call's `fetchOptions`. */
    headers: token ? { 'x-captcha-response': token } : undefined,
    /** False only while a configured widget has yet to produce a token. */
    ready: !siteKey || Boolean(token),
    reset,
    widget: siteKey ? (
      <Turnstile
        ref={instance}
        siteKey={siteKey}
        onSuccess={setToken}
        onExpire={() => setToken('')}
        onError={() => setToken('')}
        options={{ size: 'flexible' }}
      />
    ) : null,
  };
};
