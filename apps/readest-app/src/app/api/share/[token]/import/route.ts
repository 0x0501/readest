import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { validateUserAndToken } from '@/libs/auth/verify';
import { type Db, schema, withDb } from '@/libs/db';
import { rejectionToHttp, resolveActiveShare } from '@/libs/shareServer';
import { STORAGE_QUOTA_GRACE_BYTES, getStoragePlanData } from '@/utils/access';
import { copyObject, objectExists } from '@/utils/object';

interface RouteParams {
  params: Promise<{ token: string }>;
}

const isCoverKey = (fileKey: string) => /\.(png|jpe?g|webp|gif)$/i.test(fileKey);

// POST /api/share/[token]/import — recipient-side library import. Auth required.
//
// Strategy: R2 server-side byte-copy.
// The existing `files` table consumers (stats / purge / delete / download)
// all assume `file_key` starts with the row's `user_id`. A reference-based
// import would silently break those invariants, so we copy the bytes into
// the recipient's namespace instead. R2 server-side copy is one API call
// and incurs no egress.
//
// Idempotent: if the recipient already has a non-deleted `files` row for the
// same `book_hash`, we return their existing fileId with `alreadyOwned: true`
// and skip the copy. Saves egress on repeated imports. Self-imports fall out of
// the same check — the sharer's own row is a live row for that book_hash.
export async function POST(request: Request, { params }: RouteParams) {
  const { token: shareToken } = await params;

  return withDb(async (db) => {
    const { user, token: jwt } = await validateUserAndToken(
      db,
      request.headers.get('authorization'),
    );
    if (!user || !jwt) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });
    }

    const result = await resolveActiveShare(db, shareToken);
    if (!result.ok) {
      const { status, body } = rejectionToHttp(result.reason);
      return NextResponse.json(body, { status });
    }
    const { share } = result;

    // Idempotency: look up existing rows for the same (user_id, book_hash),
    // INCLUDING soft-deleted ones. file_key is unique globally, so an active
    // import that the user later deleted leaves a row that would collide with
    // a fresh insert below — we restore it instead of failing.
    let existing: { id: string; fileKey: string; deletedAt: string | null }[];
    try {
      existing = await db
        .select({
          id: schema.files.id,
          fileKey: schema.files.fileKey,
          deletedAt: schema.files.deletedAt,
        })
        .from(schema.files)
        .where(and(eq(schema.files.userId, user.id), eq(schema.files.bookHash, share.bookHash)));
    } catch (error) {
      console.error('Share import existing-row lookup failed:', error);
      return NextResponse.json({ error: 'Could not check library' }, { status: 500 });
    }

    const existingRows = existing.filter((f) => !isCoverKey(f.fileKey));
    const liveRow = existingRows.find((f) => f.deletedAt === null);
    if (liveRow) {
      return NextResponse.json({
        fileId: liveRow.id,
        alreadyOwned: true,
        bookHash: share.bookHash,
        cfi: share.cfi,
      });
    }
    const deletedRow = existingRows.find((f) => f.deletedAt !== null);
    if (deletedRow) {
      // Restore the soft-deleted row so the unique file_key constraint isn't
      // hit by a fresh insert. The bytes may also still be in storage; if the
      // copy below succeeds it overwrites them, if it doesn't we leave the
      // row in its restored state so the user can re-attempt later.
      try {
        await db
          .update(schema.files)
          .set({ deletedAt: null, updatedAt: sql`now()` })
          .where(eq(schema.files.id, deletedRow.id));
      } catch (error) {
        console.error('Share import restore-deleted-row failed:', error);
        return NextResponse.json({ error: 'Could not restore book' }, { status: 500 });
      }
      return NextResponse.json({
        fileId: deletedRow.id,
        alreadyOwned: true,
        bookHash: share.bookHash,
        cfi: share.cfi,
      });
    }

    // Quota check before doing any byte-copy work. JWT-based but consistent
    // with how the existing upload endpoint enforces it.
    const { usage, quota } = getStoragePlanData(jwt);
    if (usage + share.bookSize > quota + STORAGE_QUOTA_GRACE_BYTES) {
      return NextResponse.json(
        { error: 'Insufficient storage quota', code: 'quota_exceeded', usage, quota },
        { status: 402 },
      );
    }

    // Translate the sharer's file_keys into the recipient's namespace by
    // swapping the leading user-id prefix. Existing convention: file_key looks
    // like `${userId}/Readest/Book/{hash}/{filename}`.
    const sharerPrefix = `${share.userId}/`;
    const recipientPrefix = `${user.id}/`;

    const remap = (sourceKey: string): string | null => {
      if (!sourceKey.startsWith(sharerPrefix)) return null;
      return recipientPrefix + sourceKey.slice(sharerPrefix.length);
    };

    const destBookKey = remap(share.bookFileKey);
    if (!destBookKey) {
      console.error(
        'Share import: source key does not start with sharer user id',
        share.bookFileKey,
      );
      return NextResponse.json({ error: 'Cannot remap shared file' }, { status: 500 });
    }

    // Verify source bytes still exist before allocating a destination row.
    const sourceExists = await objectExists(share.bookFileKey);
    if (!sourceExists) {
      return NextResponse.json(
        { error: 'Shared book is no longer available', code: 'source_deleted' },
        { status: 410 },
      );
    }

    // Insert destination row first (to grab a stable id), then copy bytes,
    // then mark the row clean. On copy failure we soft-delete the row so the
    // user's library doesn't show a phantom book.
    let insertedBookId: string;
    try {
      const [inserted] = await db
        .insert(schema.files)
        .values({
          userId: user.id,
          bookHash: share.bookHash,
          fileKey: destBookKey,
          fileSize: share.bookSize,
        })
        .returning({ id: schema.files.id });
      if (!inserted) throw new Error('insert returned no row');
      insertedBookId = inserted.id;
    } catch (error) {
      console.error('Share import insert book row failed:', error);
      return NextResponse.json({ error: 'Could not import book' }, { status: 500 });
    }

    try {
      const copyResp = await copyObject(share.bookFileKey, destBookKey);
      // R2 (aws4fetch) returns a Response; S3 SDK returns a structured object.
      // Both throw on hard failures; treat any non-ok HTTP response as a fail.
      if (
        copyResp &&
        typeof (copyResp as Response).ok === 'boolean' &&
        !(copyResp as Response).ok
      ) {
        throw new Error(`R2 copy failed: ${(copyResp as Response).status}`);
      }
    } catch (err) {
      console.error('Share import book copy failed:', err);
      // Soft-delete the orphaned row so it doesn't count against quota or appear
      // in the library list.
      await db
        .update(schema.files)
        .set({ deletedAt: sql`now()` })
        .where(eq(schema.files.id, insertedBookId));
      return NextResponse.json({ error: 'Could not import book' }, { status: 500 });
    }

    await copyCoverBestEffort(db, share.coverFileKey, remap, user.id, share.bookHash);

    return NextResponse.json({
      fileId: insertedBookId,
      alreadyOwned: false,
      bookHash: share.bookHash,
      cfi: share.cfi,
    });
  });
}

// A failure here doesn't fail the import — the recipient still gets the book;
// the cover will simply be missing in their library until they refresh from
// elsewhere.
const copyCoverBestEffort = async (
  db: Db,
  coverFileKey: string | null,
  remap: (key: string) => string | null,
  userId: string,
  bookHash: string,
) => {
  if (!coverFileKey) return;
  const destCoverKey = remap(coverFileKey);
  if (!destCoverKey) return;

  try {
    if (!(await objectExists(coverFileKey))) return;
    await copyObject(coverFileKey, destCoverKey);
    await db.insert(schema.files).values({
      userId,
      bookHash,
      fileKey: destCoverKey,
      fileSize: 0, // unknown; not material — covers don't bill
    });
  } catch (err) {
    console.error('Share import cover copy failed (non-fatal):', err);
  }
};
