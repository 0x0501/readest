/**
 * AboutWindow — the version label doubles as a copy-to-clipboard control.
 *
 * On mobile there is no way to select the version string to paste it into a
 * bug report (issue #5285), so tapping the label copies it. The label must
 * keep its plain-text look: no button chrome, same classes as before.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const { mockWriteTextToClipboard, mockDispatch } = vi.hoisted(() => ({
  mockWriteTextToClipboard: vi.fn(async () => true),
  mockDispatch: vi.fn(),
}));

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => (s: string, params?: Record<string, unknown>) =>
    params ? s.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => String(params[k] ?? '')) : s,
}));

vi.mock('@/context/EnvContext', () => ({
  useEnv: () => ({ appService: { hasUpdater: true } }),
}));

vi.mock('@/utils/ua', () => ({
  parseWebViewInfo: () => 'Chrome 148',
}));

vi.mock('@/utils/version', () => ({
  getAppVersion: () => '0.11.20',
}));

vi.mock('@/utils/clipboard', () => ({
  writeTextToClipboard: mockWriteTextToClipboard,
}));

vi.mock('@/utils/event', () => ({
  eventDispatcher: { dispatch: mockDispatch, on: vi.fn(), off: vi.fn() },
}));

vi.mock('next/image', () => ({
  default: ({ alt }: { alt: string }) => <span>{alt}</span>,
}));

vi.mock('@/components/Link', () => ({
  default: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock('@/components/Dialog', () => ({
  default: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { AboutWindow, setAboutDialogVisible } from '@/components/AboutWindow';

const openDialog = async () => {
  render(
    <>
      <div id='about_window' />
      <AboutWindow />
    </>,
  );
  setAboutDialogVisible(true);
  return screen.findByText(/Version 0\.11\.20/);
};

describe('AboutWindow version label', () => {
  beforeEach(() => {
    mockWriteTextToClipboard.mockClear();
    mockDispatch.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it('copies the version and webview info when clicked', async () => {
    const label = await openDialog();

    fireEvent.click(label);

    await waitFor(() => expect(mockWriteTextToClipboard).toHaveBeenCalledTimes(1));
    expect(mockWriteTextToClipboard).toHaveBeenCalledWith('Version 0.11.20 (Chrome 148)');
  });

  it('shows a toast confirming the copy', async () => {
    const label = await openDialog();

    fireEvent.click(label);

    await waitFor(() =>
      expect(mockDispatch).toHaveBeenCalledWith(
        'toast',
        expect.objectContaining({ message: 'Copied to clipboard' }),
      ),
    );
  });

  it('keeps the plain-text look of the label', async () => {
    const label = await openDialog();

    // Same typography classes as the non-clickable label it replaces, and no
    // daisyUI button chrome that would change how it renders.
    expect(label.className).toContain('text-neutral-content');
    expect(label.className).toContain('text-center');
    expect(label.className).toContain('text-sm');
    expect(label.className).not.toContain('btn');
  });

  it('exposes the label as an accessible control', async () => {
    const label = await openDialog();

    expect(label.tagName).toBe('BUTTON');
    expect(label.getAttribute('title')).toBe('Copy');
  });
});

/**
 * What the dialog claims about itself.
 *
 * This deployment is not the published Readest app, and About is the only place
 * that says so. It is also where the AGPL §13 obligation is discharged — the
 * source link has to reach the fork that is actually running, not upstream — so
 * these are load-bearing strings rather than decoration.
 */
describe('AboutWindow provenance', () => {
  afterEach(() => cleanup());

  it('says it is a self-hosted deployment, unaffiliated with the project', async () => {
    await openDialog();

    expect(screen.getByText(/self-hosted deployment/i)).toBeTruthy();
    expect(screen.getByText(/not affiliated with the Readest project/i)).toBeTruthy();
  });

  it('links to the fork, which is what AGPL §13 requires, and not upstream', async () => {
    await openDialog();

    expect(screen.getByText(/github\.com\/0x0501\/readest/)).toBeTruthy();
    expect(screen.queryByText(/github\.com\/readest\/readest/)).toBeNull();
  });

  it('states the licence', async () => {
    await openDialog();

    expect(screen.getByText(/GNU Affero General Public License v3\.0/)).toBeTruthy();
  });

  it('offers no update check, and claims no company owns it', async () => {
    await openDialog();

    expect(screen.queryByText(/Check Update/i)).toBeNull();
    expect(screen.queryByText(/Bilingify/i)).toBeNull();
    expect(screen.queryByText(/All rights reserved/i)).toBeNull();
  });
});
