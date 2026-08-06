'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { authClient } from '@/libs/auth/client';

type Passkey = typeof authClient.$Infer.Passkey;

/**
 * Enrol, review and remove the credentials that can sign in as this account.
 *
 * Enrolment needs a session, so this lives behind the profile page rather than
 * on the sign-in page: sign in once with a password, add the device, and after
 * that the device is enough.
 *
 * The section renders on the web only — its caller gates it — because Tauri's
 * webviews serve from a custom scheme that WebAuthn's origin check rejects.
 */
export function PasskeySection() {
  const _ = useTranslation();
  const [passkeys, setPasskeys] = useState<Passkey[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    const { data } = await authClient.passkey.listUserPasskeys();
    setPasskeys(data ?? []);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleAdd = async () => {
    setBusy(true);
    setError('');
    // A name makes a list of several credentials readable later; the platform
    // does not supply one.
    const suggested = _('This device');
    const result = await authClient.passkey.addPasskey({ name: suggested });
    setBusy(false);
    if (result?.error) {
      setError(result.error.message ?? _('Could not add a passkey'));
      return;
    }
    await refresh();
  };

  const handleDelete = async (id: string) => {
    setBusy(true);
    setError('');
    const { error: deleteError } = await authClient.passkey.deletePasskey({ id });
    setBusy(false);
    if (deleteError) {
      setError(deleteError.message ?? _('Could not remove that passkey'));
      return;
    }
    await refresh();
  };

  return (
    <div className='flex flex-col gap-4'>
      <div>
        <h2 className='text-base-content text-lg font-bold'>{_('Passkeys')}</h2>
        <p className='text-neutral-content text-sm'>
          {_('Sign in with the fingerprint, face or screen lock this device already uses.')}
        </p>
      </div>

      {passkeys?.length === 0 && (
        <p className='text-neutral-content text-sm'>{_('No passkeys yet.')}</p>
      )}

      {passkeys && passkeys.length > 0 && (
        <ul className='flex flex-col gap-2'>
          {passkeys.map((passkey) => (
            <li
              key={passkey.id}
              className='border-base-300 eink-bordered flex items-center justify-between gap-4 rounded-lg border px-4 py-3'
            >
              <div className='min-w-0'>
                <p className='text-base-content truncate text-sm'>
                  {passkey.name || _('Unnamed passkey')}
                </p>
                <p className='text-neutral-content text-xs'>
                  {new Date(passkey.createdAt).toLocaleDateString()}
                </p>
              </div>
              <button
                onClick={() => handleDelete(passkey.id)}
                disabled={busy}
                className='rounded-lg bg-red-100 px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-200'
              >
                {_('Remove')}
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className='text-error text-sm'>{error}</p>}

      <button
        onClick={handleAdd}
        disabled={busy}
        className='w-full rounded-lg bg-gray-200 px-6 py-3 font-medium text-gray-800 transition-colors hover:bg-gray-300 md:w-auto'
      >
        {busy ? _('Adding a passkey...') : _('Add a passkey')}
      </button>
    </div>
  );
}
