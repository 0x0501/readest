import { and, eq, isNull, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';

interface RouteParams {
  params: Promise<{ token: string }>;
}

// POST /api/share/[token]/revoke — owner-only. Sets revoked_at = now() so
// future landing-page visits and downloads return 410. Note: presigned URLs
// already minted (max ~5 min TTL) cannot be canceled — this is a documented
// soft-revocation grace, not a hard guarantee.
export async function POST(request: Request, { params }: RouteParams) {
  const { token } = await params;

  if (!isValidShareToken(token)) {
    return NextResponse.json({ error: 'Invalid share token' }, { status: 400 });
  }

  return withDb(async (db) => {
    const { user, token: jwt } = await validateUserAndToken(
      db,
      request.headers.get('authorization'),
    );
    if (!user || !jwt) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const tokenHash = await hashShareToken(token);

    let share: { id: string; userId: string; revokedAt: string | null } | undefined;
    try {
      [share] = await db
        .select({
          id: schema.bookShares.id,
          userId: schema.bookShares.userId,
          revokedAt: schema.bookShares.revokedAt,
        })
        .from(schema.bookShares)
        .where(eq(schema.bookShares.tokenHash, tokenHash))
        .limit(1);
    } catch (error) {
      console.error('book_shares lookup failed:', error);
      return NextResponse.json({ error: 'Could not look up share' }, { status: 500 });
    }

    if (!share) {
      return NextResponse.json({ error: 'Share not found' }, { status: 404 });
    }
    // Ownership is checked here rather than folded into the lookup so a
    // stranger's token reads as 403 and a bad token as 404, which is what the
    // client distinguishes on.
    if (share.userId !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    // Idempotent: re-revoking returns success without churning the timestamp.
    if (share.revokedAt) {
      return new NextResponse(null, { status: 204 });
    }

    try {
      await db
        .update(schema.bookShares)
        .set({ revokedAt: sql`now()` })
        .where(and(eq(schema.bookShares.id, share.id), isNull(schema.bookShares.revokedAt)));
    } catch (error) {
      console.error('book_shares revoke failed:', error);
      return NextResponse.json({ error: 'Could not revoke share' }, { status: 500 });
    }

    return new NextResponse(null, { status: 204 });
  });
}
