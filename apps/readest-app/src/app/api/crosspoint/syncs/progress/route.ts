import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import {
  authenticateDevice,
  BOOK_HASH,
  parseConfigProgress,
  PERCENT_PAGES,
} from '@/libs/crosspoint';
import {
  insertBookConfigProgress,
  readBookConfig,
  updateBookConfigProgress,
  updateBookLibraryProgress,
  userIdForDeviceKeyHash,
} from '@/libs/crosspointQueries';

// PUT /api/crosspoint/syncs/progress — store a CrossPoint position in the book
// config Readest apps already sync, which apply its XPointer when they open
// the book.
export async function PUT(request: Request) {
  const userId = await withDb((db) =>
    authenticateDevice(request, (keyHash) => userIdForDeviceKeyHash(db, keyHash)),
  );
  if (typeof userId !== 'string') return userId;

  const body = await request.json().catch(() => null);
  const { document, progress, percentage } = (body ?? {}) as Record<string, unknown>;
  if (
    typeof document !== 'string' ||
    !BOOK_HASH.test(document) ||
    typeof progress !== 'string' ||
    !progress.startsWith('/body') ||
    progress.length > 4096 ||
    typeof percentage !== 'number' ||
    !(percentage >= 0 && percentage <= 1)
  ) {
    return NextResponse.json({ message: 'Invalid progress' }, { status: 400 });
  }

  const now = new Date().toISOString();
  const response = NextResponse.json({ document, timestamp: Math.floor(Date.parse(now) / 1000) });

  try {
    const saved = await withDb(async (db) => {
      const existing = await readBookConfig(db, userId, document, false);
      const stored = parseConfigProgress(existing?.progress);
      // Without a stored XPointer the reader's sync found nothing to pull, so it
      // uploads its own position, usually the start of a fresh download. That
      // must not pull back a position Readest is already past.
      if (stored && !existing?.xpointer && percentage < stored[0] / stored[1]) return 'skipped';

      // The percentage in the book's Readest page count, or in whole percents
      // until a Readest app has paginated the book.
      const total = stored?.[1] ?? PERCENT_PAGES;
      const pages: [number, number] = [Math.max(1, Math.round(percentage * total)), total];
      const fields = {
        userId,
        bookHash: document,
        xpointer: progress,
        progress: pages,
        updatedAt: now,
      };
      // Never overwrite a newer write, from a Readest app or a racing request.
      if (existing) await updateBookConfigProgress(db, fields);
      else await insertBookConfigProgress(db, fields);
      return pages;
    });
    if (saved === 'skipped') return response;

    try {
      await withDb((db) =>
        updateBookLibraryProgress(db, {
          userId,
          bookHash: document,
          progress: saved,
          updatedAt: now,
        }),
      );
    } catch (error) {
      // Like /api/sync: keep the library row's progress current, never
      // overwriting a newer books push. A missing update must not fail the push.
      const message = error instanceof Error ? error.message : String(error);
      console.warn('books.progress update failed for', document, message);
    }
    return response;
  } catch {
    return NextResponse.json({ message: 'Could not save progress' }, { status: 500 });
  }
}
