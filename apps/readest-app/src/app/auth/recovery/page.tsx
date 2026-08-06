'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { IoArrowBack } from 'react-icons/io5';
import { useTranslation } from '@/hooks/useTranslation';
import { authClient } from '@/libs/auth/client';

/**
 * Changing a password, not recovering one. A forgotten-password flow needs a
 * link mailed to the address on file, and this deployment configures no outbound
 * mail — so the only version that can work is the one that asks for the password
 * the caller already has.
 */
export default function ChangePasswordPage() {
  const _ = useTranslation();
  const router = useRouter();

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    // Other sessions go with it: a password change is what someone does after
    // they suspect one of them is not theirs.
    const { error: authError } = await authClient.changePassword({
      currentPassword,
      newPassword,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (authError) {
      setError(authError.message ?? _('Failed to update password'));
      return;
    }
    setDone(true);
    setCurrentPassword('');
    setNewPassword('');
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
          {_('Update password')}
        </h1>

        <form onSubmit={handleSubmit} className='flex flex-col gap-3'>
          <input
            type='password'
            autoComplete='current-password'
            required
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder={_('Your password')}
            className='input input-bordered eink-bordered w-full'
          />
          <input
            type='password'
            autoComplete='new-password'
            required
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder={_('Your new password')}
            className='input input-bordered eink-bordered w-full'
          />
          {error && <p className='text-error text-sm'>{error}</p>}
          {done && (
            <p className='text-base-content text-sm'>{_('Your password has been updated')}</p>
          )}
          <button type='submit' disabled={busy} className='btn btn-contrast w-full'>
            {busy ? _('Updating password ...') : _('Update password')}
          </button>
        </form>
      </div>
    </div>
  );
}
