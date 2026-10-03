import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { authenticateDevice, parseConfigProgress } from '@/libs/crosspoint';
import { readBookConfig, userIdForDeviceKeyHash } from '@/libs/crosspointQueries';

// GET /api/crosspoint/syncs/progress/:document — the XPointer Readest last
// synced for the book (document = partial MD5 = book_hash).
export async function GET(request: Request, { params }: { params: Promise<{ document: string }> }) {
  const userId = await withDb((db) =>
    authenticateDevice(request, (keyHash) => userIdForDeviceKeyHash(db, keyHash)),
  );
  if (typeof userId !== 'string') return userId;

  const { document } = await params;
  try {
    const data = await withDb((db) => readBookConfig(db, userId, document, true));
    // CrossPoint treats 404 as "no remote progress yet".
    if (!data?.xpointer || !data.updatedAt) {
      return NextResponse.json({ message: 'Not found' }, { status: 404 });
    }
    const progress = parseConfigProgress(data.progress);
    return NextResponse.json({
      document,
      progress: data.xpointer,
      percentage: progress ? progress[0] / progress[1] : 0,
      device: 'Readest',
      device_id: 'readest',
      timestamp: Math.floor(Date.parse(data.updatedAt) / 1000),
    });
  } catch {
    return NextResponse.json({ message: 'Could not read progress' }, { status: 500 });
  }
}
