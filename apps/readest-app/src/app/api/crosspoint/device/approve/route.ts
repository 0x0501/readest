import { NextResponse } from 'next/server';
import { getUserEmail, validateUserAndToken } from '@/libs/auth/verify';
import { withDb } from '@/libs/db';
import { approveDeviceCode } from '@/libs/crosspointQueries';

// A code as typed: any case, spacing or dash around its 8 letters.
const normalizeUserCode = (value: unknown) => {
  const letters = typeof value === 'string' ? value.toUpperCase().replace(/[\s-]/g, '') : '';
  return /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/.test(letters)
    ? `${letters.slice(0, 4)}-${letters.slice(4)}`
    : null;
};

// POST /api/crosspoint/device/approve {user_code} — the signed-in owner approves
// the code a reader shows, from the web app's /link page.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const userCode = normalizeUserCode((body as { user_code?: unknown } | null)?.user_code);
  if (!userCode) return NextResponse.json({ error: 'Invalid code' }, { status: 400 });

  try {
    const updated = await withDb(async (db) => {
      const { user } = await validateUserAndToken(db, request.headers.get('authorization'));
      if (!user) return 'unauthenticated' as const;
      const email = await getUserEmail(db, user.id);
      return approveDeviceCode(db, {
        userCode,
        userId: user.id,
        username: email ?? user.id,
        now: new Date().toISOString(),
      });
    });
    if (updated === 'unauthenticated') {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }
    if (!updated) {
      return NextResponse.json({ error: 'Code not found or expired' }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Could not approve the code' }, { status: 500 });
  }
}
