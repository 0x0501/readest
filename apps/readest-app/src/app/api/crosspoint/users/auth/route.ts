import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { authenticateDevice } from '@/libs/crosspoint';
import { userIdForDeviceKeyHash } from '@/libs/crosspointQueries';

// GET /api/crosspoint/users/auth — KOSync credential check.
export async function GET(request: Request) {
  const userId = await withDb((db) =>
    authenticateDevice(request, (keyHash) => userIdForDeviceKeyHash(db, keyHash)),
  );
  if (typeof userId !== 'string') return userId;
  return NextResponse.json({ authorized: 'OK' });
}
