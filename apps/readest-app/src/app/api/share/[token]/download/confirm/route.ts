import { sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { hashShareToken, isValidShareToken } from '@/libs/shareServer';

interface RouteParams {
  params: Promise<{ token: string }>;
}

// POST /api/share/[token]/download/confirm — analytics ping fired by the
// landing-page Download button (post-click) and the in-app deeplink hook on
// successful import. Best-effort: the user-facing action does not depend on
// this returning 2xx. Lookup is by token_hash so the row stays cheap to find.
//
// Increments are done in a single SQL UPDATE so concurrent requests cannot
// race a read-modify-write. We also accept the small risk that an increment
// lands shortly after a revoke — that's harmless, the counter doesn't grant
// access. The validity check inside the function skips obviously dead shares
// so crawlers hitting expired links don't pollute the count after the fact.
export async function POST(_request: Request, { params }: RouteParams) {
  const { token } = await params;

  if (!isValidShareToken(token)) {
    // Silently OK — this is a best-effort beacon, not an enforcement point.
    return new NextResponse(null, { status: 204 });
  }

  const tokenHash = await hashShareToken(token);

  try {
    // Upstream's function, called as-is (ADR-010). `now()` rather than a
    // timestamp from here: it is compared against `expires_at` in the same
    // database, so the database's clock is the one that should decide.
    await withDb((db) =>
      db.execute(sql`select public.increment_book_share_download(${tokenHash}, now())`),
    );
  } catch (error) {
    // Best-effort beacon — log but never surface to the caller.
    console.error('download confirm rpc failed:', error);
  }

  return new NextResponse(null, {
    status: 204,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}
