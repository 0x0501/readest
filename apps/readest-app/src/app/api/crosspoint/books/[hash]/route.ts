import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { getDownloadSignedUrl } from '@/utils/object';
import { authenticateDevice, BOOK_HASH } from '@/libs/crosspoint';
import { liveFileKeys, userIdForDeviceKeyHash } from '@/libs/crosspointQueries';

// GET /api/crosspoint/books/:hash — a short-lived link to one EPUB in the
// owner's cloud library, the catalog's download hop.
export async function GET(request: Request, { params }: { params: Promise<{ hash: string }> }) {
  const userId = await withDb((db) =>
    authenticateDevice(request, (keyHash) => userIdForDeviceKeyHash(db, keyHash)),
  );
  if (typeof userId !== 'string') return userId;

  const { hash } = await params;
  if (!BOOK_HASH.test(hash)) return NextResponse.json({ error: 'Invalid book' }, { status: 400 });

  try {
    const data = await withDb((db) => liveFileKeys(db, userId, hash));
    const file = data.find((row) => row.fileKey.toLowerCase().endsWith('.epub'));
    if (!file) return NextResponse.json({ error: 'Book not found' }, { status: 404 });
    return NextResponse.json({ downloadUrl: await getDownloadSignedUrl(file.fileKey, 1800) });
  } catch (error) {
    console.error('crosspoint book download link failed:', error);
    return NextResponse.json({ error: 'Could not link the book' }, { status: 500 });
  }
}
