import { and, desc, eq, lt, or } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { SHARE_BASE_URL } from '@/services/constants';

const PAGE_SIZE = 25;

// GET /api/share/list?cursor=<created_at_iso>|<id>
// Owner-only. Cursor-paginated list of the caller's shares (active + expired).
// Cursor format mirrors the (created_at DESC, id DESC) order so duplicates and
// drops are impossible across pages even when rows are added concurrently.
export async function GET(request: Request) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, request.headers.get('authorization'));
    if (!user || !token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const url = new URL(request.url);
    const rawCursor = url.searchParams.get('cursor');
    let cursorCreatedAt: string | null = null;
    let cursorId: string | null = null;
    if (rawCursor) {
      const sep = rawCursor.indexOf('|');
      if (sep > 0) {
        cursorCreatedAt = rawCursor.slice(0, sep);
        cursorId = rawCursor.slice(sep + 1);
      }
    }

    // Scoping by user_id is the authorization, now that RLS is not the layer
    // enforcing it (ADR-005). Never widen this predicate: the row carries the
    // plaintext token.
    const scope = eq(schema.bookShares.userId, user.id);
    // Strict less-than on (created_at, id) so ties are not skipped.
    const after =
      cursorCreatedAt && cursorId
        ? or(
            lt(schema.bookShares.createdAt, cursorCreatedAt),
            and(
              eq(schema.bookShares.createdAt, cursorCreatedAt),
              lt(schema.bookShares.id, cursorId),
            ),
          )
        : undefined;

    let rows: (typeof schema.bookShares.$inferSelect)[];
    try {
      rows = await db
        .select()
        .from(schema.bookShares)
        .where(after ? and(scope, after) : scope)
        .orderBy(desc(schema.bookShares.createdAt), desc(schema.bookShares.id))
        .limit(PAGE_SIZE + 1);
    } catch (error) {
      console.error('book_shares list failed:', error);
      return NextResponse.json({ error: 'Could not list shares' }, { status: 500 });
    }

    const hasMore = rows.length > PAGE_SIZE;
    const page = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
    const last = page.length > 0 ? page[page.length - 1] : null;
    const nextCursor = hasMore && last ? `${last.createdAt}|${last.id}` : null;

    return NextResponse.json({
      shares: page.map((row) => ({
        id: row.id,
        // Plaintext token, surfaced to the OWNER only. This endpoint is
        // auth-gated and the query is scoped by user_id, so a token never
        // leaves the sharer's session.
        token: row.token,
        bookHash: row.bookHash,
        title: row.bookTitle,
        author: row.bookAuthor,
        format: row.bookFormat,
        size: row.bookSize,
        hasCfi: !!row.cfi,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        downloadCount: row.downloadCount,
        createdAt: row.createdAt,
      })),
      nextCursor,
      shareUrlBase: SHARE_BASE_URL,
    });
  });
}
