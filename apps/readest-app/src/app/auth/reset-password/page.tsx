'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { authClient } from '@/libs/auth/client';

/**
 * The far end of the mailed reset link.
 *
 * Better Auth's `/reset-password/:token` has already checked the token by the
 * time anything lands here: a good one arrives as `?token=`, a spent or expired
 * one as `?error=INVALID_TOKEN`. So this page never validates anything itself,
 * and never holds a token that has not been vouched for.
 *
 * No captcha here — the mailed token is the rate limit, and the request that
 * produced it was already challenged.
 */
export default function ResetPasswordPage() {
  const _ = useTranslation();
  const router = useRouter();

  const [token, setToken] = useState<string | null>(null);
  const [linkInvalid, setLinkInvalid] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get('token');
    if (fromLink) setToken(fromLink);
    else setLinkInvalid(true);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setBusy(true);
    setError('');
    const { error: authError } = await authClient.resetPassword({ newPassword: password, token });
    setBusy(false);
    if (authError) {
      setError(authError.message ?? _('Failed to update password'));
      return;
    }
    setDone(true);
    setPassword('');
  };

  return (
    <div className='bg-base-100 flex min-h-screen items-center justify-center'>
      <div className='w-full max-w-sm px-8'>
        <h1 className='text-base-content mb-6 text-center text-xl font-bold'>
          {_('Choose a new password')}
        </h1>

        {linkInvalid && (
          <div className='flex flex-col gap-3 text-center'>
            <p className='text-base-content text-sm'>
              {_('That reset link has expired or has already been used.')}
            </p>
            <Link href='/auth/forgot-password' className='btn btn-contrast w-full'>
              {_('Send a new one')}
            </Link>
          </div>
        )}

        {done && (
          <div className='flex flex-col gap-3 text-center'>
            <p className='text-base-content text-sm'>{_('Your password has been updated')}</p>
            <button onClick={() => router.replace('/auth')} className='btn btn-contrast w-full'>
              {_('Sign in')}
            </button>
          </div>
        )}

        {token && !done && (
          <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
            <input
              type='password'
              autoComplete='new-password'
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={_('Your new password')}
              className='input input-bordered eink-bordered w-full'
            />
            {error && <p className='text-error text-sm'>{error}</p>}
            <button type='submit' disabled={busy} className='btn btn-contrast w-full'>
              {busy ? _('Updating password ...') : _('Update password')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
