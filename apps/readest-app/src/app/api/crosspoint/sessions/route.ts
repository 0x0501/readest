import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { DEFAULT_STATS_TRACKING_CONFIG } from '@/types/statistics';
import {
  authenticateDevice,
  BOOK_HASH,
  parseConfigProgress,
  PERCENT_PAGES,
} from '@/libs/crosspoint';
import { insertStatPages, readBookConfig, userIdForDeviceKeyHash } from '@/libs/crosspointQueries';

const BASIS_POINTS = 10000;

const isCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;

// POST /api/crosspoint/sessions {document, start_time, duration, start_bp, end_bp}
// One reading session from the reader (its reader.session event), recorded
// as Readest page statistics: the session's time spread evenly over the pages
// it covered, in the book's Readest page count, like Readest's own page visits.
export async function POST(request: Request) {
  const userId = await withDb((db) =>
    authenticateDevice(request, (keyHash) => userIdForDeviceKeyHash(db, keyHash)),
  );
  if (typeof userId !== 'string') return userId;

  const body = await request.json().catch(() => null);
  const { document, start_time, duration, start_bp, end_bp } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (
    typeof document !== 'string' ||
    !BOOK_HASH.test(document) ||
    !isCount(start_time) ||
    !isCount(duration) ||
    !isCount(start_bp) ||
    !isCount(end_bp) ||
    start_time === 0 ||
    duration === 0
  ) {
    // The reader retries a failed delivery before sending any later event, so
    // a session that can never be recorded is dropped instead of refused.
    return NextResponse.json({ pages: 0 });
  }

  try {
    const pages = await withDb(async (db) => {
      // Readest's page count once a Readest app has paginated the book, else whole percents.
      const config = await readBookConfig(db, userId, document, false);
      const total = parseConfigProgress(config?.progress)?.[1] ?? PERCENT_PAGES;

      const pageAt = (bp: number) =>
        Math.min(total, Math.floor((Math.min(bp, BASIS_POINTS) * total) / BASIS_POINTS) + 1);
      const first = pageAt(Math.min(start_bp, end_bp));
      const last = pageAt(Math.max(start_bp, end_bp));
      // Readest drops page visits shorter than this. A session that crossed more
      // pages than its time allows skipped ahead; it read the pages it ended on.
      const count = Math.min(
        last - first + 1,
        Math.max(1, Math.floor(duration / DEFAULT_STATS_TRACKING_CONFIG.minEventSeconds)),
      );
      const rows = Array.from({ length: count }, (_, i) => {
        const from = Math.floor((i * duration) / count);
        const to = Math.floor(((i + 1) * duration) / count);
        return {
          userId,
          bookHash: document,
          page: last - count + 1 + i,
          startTime: start_time + from,
          duration: to - from,
          totalPages: total,
        };
      });
      // The same event delivered again yields the same rows and adds nothing.
      await insertStatPages(db, rows);
      return rows.length;
    });
    return NextResponse.json({ pages });
  } catch {
    return NextResponse.json({ error: 'Could not record the session' }, { status: 500 });
  }
}
