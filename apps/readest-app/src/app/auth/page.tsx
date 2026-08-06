'use client';

import { WebAuthnAbortService } from '@simplewebauthn/browser';
import clsx from 'clsx';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FaGithub } from 'react-icons/fa';
import { IoArrowBack } from 'react-icons/io5';
import { MdKey } from 'react-icons/md';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from '@/hooks/useTranslation';
import { useTurnstile } from '@/hooks/useTurnstile';
import { authClient } from '@/libs/auth/client';
import { isWebAppPlatform } from '@/services/environment';
import { getRuntimeConfig } from '@/services/runtimeConfig';

type Mode = 'sign-in' | 'sign-up';

export default function AuthPage() {
  const _ = useTranslation();
  const router = useRouter();
  const { user } = useAuth();
  useTheme({ systemUIVisible: false });

  const [mode, setMode] = useState<Mode>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const captcha = useTurnstile();

  // Tauri's webviews serve from a custom scheme, which WebAuthn's origin check
  // cannot be satisfied from, so there is nothing to offer there.
  const passkeysAvailable = isWebAppPlatform();

  const redirectTo =
    typeof window === 'undefined'
      ? '/library'
      : (new URLSearchParams(window.location.search).get('redirect') ?? '/library');

  // AuthProvider is what notices the session; this page only has to leave once
  // it has. That covers the OAuth return too, which lands back here with a
  // cookie already set rather than on a callback page of its own.
  useEffect(() => {
    if (user) router.replace(redirectTo);
  }, [user, redirectTo, router]);

  // Conditional UI: asks the platform to offer any passkey for this site through
  // the browser's own autofill, which is what puts Face ID in the iPhone's
  // keyboard bar without the reader tapping anything. It resolves only if one is
  // chosen, so there is nothing to await and nothing to report.
  //
  // The cleanup is not optional. This ceremony stays open until something
  // cancels it, and leaving this page is a client-side route change rather than
  // a new document — so without it the request outlives the sign-in screen and
  // sits armed for the rest of the session. Cancelling on navigation is what
  // @simplewebauthn/browser documents this service for.
  useEffect(() => {
    if (!passkeysAvailable) return;
    void authClient.signIn.passkey({ autoFill: true });
    return () => WebAuthnAbortService.cancelCeremony();
  }, [passkeysAvailable]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const fetchOptions = { headers: captcha.headers };
    const { error: authError } =
      mode === 'sign-in'
        ? await authClient.signIn.email({ email, password, fetchOptions })
        : // Better Auth requires a display name. Asking for one during an
          // invite-only sign-up buys nothing the address does not already say.
          await authClient.signUp.email({
            email,
            password,
            name: email.split('@')[0]!,
            fetchOptions,
          });
    setBusy(false);
    if (authError) {
      setError(authError.message ?? _('Authentication failed'));
      captcha.reset();
    }
  };

  const handlePasskey = async () => {
    setError('');
    const result = await authClient.signIn.passkey();
    if (result?.error) setError(result.error.message ?? _('Authentication failed'));
  };

  const handleGithub = async () => {
    setError('');
    await authClient.signIn.social({ provider: 'github', callbackURL: redirectTo });
  };

  return (
    <div className='bg-base-100 flex min-h-screen items-center justify-center'>
      <button
        aria-label={_('Go Back')}
        onClick={() => router.back()}
        className='btn btn-ghost absolute left-6 top-6 h-8 min-h-8 w-8 p-0'
      >
        <IoArrowBack className='text-base-content' />
      </button>

      <div className='w-full max-w-sm px-8'>
        <h1 className='text-base-content mb-6 text-center text-xl font-bold'>
          {mode === 'sign-in' ? _('Sign in') : _('Sign up')}
        </h1>

        <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
          <input
            type='email'
            // `webauthn` is what makes the platform offer a saved passkey from
            // the field's own autofill menu.
            autoComplete={passkeysAvailable ? 'email webauthn' : 'email'}
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={_('Your email address')}
            className='input input-bordered eink-bordered w-full'
          />
          <input
            type='password'
            autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={_('Your password')}
            className='input input-bordered eink-bordered w-full'
          />
          {captcha.widget}
          {error && <p className='text-error text-sm'>{error}</p>}
          <button
            type='submit'
            disabled={busy || !captcha.ready}
            className='btn btn-contrast w-full'
          >
            {mode === 'sign-in'
              ? busy
                ? _('Signing in...')
                : _('Sign in')
              : busy
                ? _('Signing up...')
                : _('Sign up')}
          </button>
        </form>

        {mode === 'sign-in' && (
          <Link
            href='/auth/forgot-password'
            className='btn btn-ghost btn-sm mt-1 w-full font-normal'
          >
            {_('Forgot your password?')}
          </Link>
        )}

        {(passkeysAvailable || getRuntimeConfig()?.githubSignIn) && (
          <div aria-hidden='true' className='border-base-300 my-5 border-t' />
        )}

        {passkeysAvailable && (
          <button
            onClick={handlePasskey}
            className='btn btn-outline eink-bordered w-full gap-2'
            type='button'
          >
            <MdKey />
            {_('Sign in with a passkey')}
          </button>
        )}

        {getRuntimeConfig()?.githubSignIn && (
          <button
            onClick={handleGithub}
            className={clsx(
              'btn btn-outline eink-bordered w-full gap-2',
              passkeysAvailable && 'mt-3',
            )}
            type='button'
          >
            <FaGithub />
            {_('Sign in with {{provider}}', { provider: 'GitHub' })}
          </button>
        )}

        <button
          onClick={() => {
            setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in');
            setError('');
          }}
          className={clsx('btn btn-ghost btn-sm mt-4 w-full font-normal')}
        >
          {mode === 'sign-in'
            ? _("Don't have an account? Sign up")
            : _('Already have an account? Sign in')}
        </button>
      </div>
    </div>
  );
}
