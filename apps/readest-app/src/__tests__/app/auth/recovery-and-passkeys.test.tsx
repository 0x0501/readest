/**
 * The three signed-out auth screens, at the seam a reader actually meets them.
 *
 * What these guard is mostly presence and absence: a passkey control offered on
 * a platform that cannot run WebAuthn is a button that can only fail, a captcha
 * widget rendered without a site key is the same, and a reset page that renders
 * its form for a spent link asks for a password it cannot save. None of those
 * throw — they just quietly do not work — so nothing else in the suite notices.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { signInEmail, signUpEmail, signInPasskey, requestPasswordReset, resetPassword } = vi.hoisted(
  () => ({
    signInEmail: vi.fn(async () => ({ error: null })),
    signUpEmail: vi.fn(async () => ({ error: null })),
    signInPasskey: vi.fn(async () => ({ error: null })),
    requestPasswordReset: vi.fn(async () => ({ error: null })),
    resetPassword: vi.fn(async () => ({ error: null })),
  }),
);

const { runtimeConfig, webPlatform } = vi.hoisted(() => ({
  runtimeConfig: { value: {} as Record<string, unknown> },
  webPlatform: { value: true },
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string) => s,
}));
vi.mock('@/hooks/useTheme', () => ({ useTheme: () => ({}) }));
vi.mock('@/context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
}));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/libs/auth/client', () => ({
  authClient: {
    signIn: { email: signInEmail, passkey: signInPasskey, social: vi.fn() },
    signUp: { email: signUpEmail },
    requestPasswordReset,
    resetPassword,
  },
}));
vi.mock('@/services/runtimeConfig', () => ({ getRuntimeConfig: () => runtimeConfig.value }));
vi.mock('@/services/environment', () => ({ isWebAppPlatform: () => webPlatform.value }));
// The real widget injects Cloudflare's script; only its presence matters here.
vi.mock('@marsidev/react-turnstile', () => ({
  Turnstile: ({ siteKey }: { siteKey: string }) => (
    <div data-testid='turnstile' data-key={siteKey} />
  ),
}));

import AuthPage from '@/app/auth/page';
import ForgotPasswordPage from '@/app/auth/forgot-password/page';
import ResetPasswordPage from '@/app/auth/reset-password/page';

const setSearch = (search: string) => {
  window.history.replaceState({}, '', `/auth/reset-password${search}`);
};

beforeEach(() => {
  vi.clearAllMocks();
  runtimeConfig.value = {};
  webPlatform.value = true;
  setSearch('');
});

afterEach(() => cleanup());

describe('sign-in page', () => {
  it('offers a way out for a forgotten password', () => {
    render(<AuthPage />);

    const link = screen.getByText('Forgot your password?').closest('a');
    expect(link?.getAttribute('href')).toBe('/auth/forgot-password');
  });

  it('offers passkeys on the web, and asks the platform to autofill one', () => {
    render(<AuthPage />);

    expect(screen.getByText('Sign in with a passkey')).toBeTruthy();
    // Conditional UI — this is what surfaces Face ID in the iPhone keyboard bar.
    expect(signInPasskey).toHaveBeenCalledWith({ autoFill: true });
    expect(screen.getByPlaceholderText('Your email address').getAttribute('autocomplete')).toBe(
      'email webauthn',
    );
  });

  // Tauri webviews load from a custom scheme, so WebAuthn's origin check can
  // never pass there. Showing the control anyway offers a guaranteed failure.
  it('offers no passkey control where WebAuthn cannot run', () => {
    webPlatform.value = false;

    render(<AuthPage />);

    expect(screen.queryByText('Sign in with a passkey')).toBeNull();
    expect(signInPasskey).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Your email address').getAttribute('autocomplete')).toBe(
      'email',
    );
  });

  it('renders no captcha, and stays submittable, when none is configured', () => {
    render(<AuthPage />);

    expect(screen.queryByTestId('turnstile')).toBeNull();
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(false);
  });

  // Until the widget produces a token the request would be rejected by the
  // server, so submitting has to wait rather than fail.
  it('renders the captcha and holds submit until it answers, when configured', () => {
    runtimeConfig.value = { turnstileSiteKey: 'site-key' };

    render(<AuthPage />);

    expect(screen.getByTestId('turnstile').getAttribute('data-key')).toBe('site-key');
    expect(screen.getByRole('button', { name: 'Sign in' }).hasAttribute('disabled')).toBe(true);
  });
});

describe('forgot-password page', () => {
  it('reports the same thing whether or not the address has an account', async () => {
    render(<ForgotPasswordPage />);
    fireEvent.change(screen.getByPlaceholderText('Your email address'), {
      target: { value: 'reader@example.test' },
    });
    fireEvent.click(screen.getByText('Send the reset link'));

    await waitFor(() =>
      expect(screen.getByText('If that address has an account, a reset link is on its way.')),
    );
    expect(requestPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'reader@example.test' }),
    );
  });
});

describe('reset-password page', () => {
  // Better Auth's own endpoint has already checked the token by the time the
  // browser lands here, so a good one arrives in the query string.
  it('asks for a new password when the link carried a verified token', async () => {
    setSearch('?token=verified-token');

    render(<ResetPasswordPage />);

    const field = await screen.findByPlaceholderText('Your new password');
    fireEvent.change(field, { target: { value: 'a brand new password' } });
    fireEvent.click(screen.getByText('Update password'));

    await waitFor(() =>
      expect(resetPassword).toHaveBeenCalledWith({
        newPassword: 'a brand new password',
        token: 'verified-token',
      }),
    );
  });

  // A spent or expired link comes back as `?error=`, with no token. Rendering
  // the form anyway would take a password it has no way to save.
  it('offers a fresh link, and no form, when the link was refused', async () => {
    setSearch('?error=INVALID_TOKEN');

    render(<ResetPasswordPage />);

    expect(
      await screen.findByText('That reset link has expired or has already been used.'),
    ).toBeTruthy();
    expect(screen.queryByPlaceholderText('Your new password')).toBeNull();
    expect(screen.getByText('Send a new one').closest('a')?.getAttribute('href')).toBe(
      '/auth/forgot-password',
    );
  });
});
