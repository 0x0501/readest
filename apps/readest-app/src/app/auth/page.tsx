'use client';

import clsx from 'clsx';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FaGithub } from 'react-icons/fa';
import { IoArrowBack } from 'react-icons/io5';
import { useAuth } from '@/context/AuthContext';
import { useTheme } from '@/hooks/useTheme';
import { useTranslation } from '@/hooks/useTranslation';
import { authClient } from '@/libs/auth/client';
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: authError } =
      mode === 'sign-in'
        ? await authClient.signIn.email({ email, password })
        : // Better Auth requires a display name. Asking for one during an
          // invite-only sign-up buys nothing the address does not already say.
          await authClient.signUp.email({ email, password, name: email.split('@')[0]! });
    setBusy(false);
    if (authError) setError(authError.message ?? _('Authentication failed'));
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
            autoComplete='email'
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
          {error && <p className='text-error text-sm'>{error}</p>}
          <button type='submit' disabled={busy} className='btn btn-contrast w-full'>
            {mode === 'sign-in'
              ? busy
                ? _('Signing in...')
                : _('Sign in')
              : busy
                ? _('Signing up...')
                : _('Sign up')}
          </button>
        </form>

        {getRuntimeConfig()?.githubSignIn && (
          <>
            <div aria-hidden='true' className='border-base-300 my-5 border-t' />
            <button onClick={handleGithub} className='btn btn-outline eink-bordered w-full gap-2'>
              <FaGithub />
              {_('Sign in with {{provider}}', { provider: 'GitHub' })}
            </button>
          </>
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
