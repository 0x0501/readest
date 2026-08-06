'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { IoArrowBack } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { useTurnstile } from '@/hooks/useTurnstile';
import { authClient } from '@/libs/auth/client';

/**
 * Recovering a password nobody knows, which is the case `/auth/recovery` cannot
 * serve — that one asks for the current password (ADR-016).
 *
 * Better Auth mails a link to its own `/reset-password/:token`, which verifies
 * the token and forwards to `redirectTo` with a validated one, so this page's
 * only job is to ask for the address.
 */
export default function ForgotPasswordPage() {
  const _ = useTranslation();
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const captcha = useTurnstile();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: authError } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/auth/reset-password`,
      fetchOptions: { headers: captcha.headers },
    });
    setBusy(false);
    if (authError) {
      setError(authError.message ?? _('Failed to send the reset link'));
      captcha.reset();
      return;
    }
    setSent(true);
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
          {_('Reset your password')}
        </h1>

        {sent ? (
          <p className='text-base-content text-center text-sm'>
            {_('If that address has an account, a reset link is on its way.')}
          </p>
        ) : (
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
            {captcha.widget}
            {error && <p className='text-error text-sm'>{error}</p>}
            <button
              type='submit'
              disabled={busy || !captcha.ready}
              className='btn btn-contrast w-full'
            >
              {busy ? _('Sending the reset link...') : _('Send the reset link')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
