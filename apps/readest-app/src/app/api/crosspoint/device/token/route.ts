import { NextResponse } from 'next/server';
import { withDb } from '@/libs/db';
import { hashDeviceKey, newSecret, sha256Hex } from '@/libs/crosspoint';
import {
  claimApprovedDeviceCode,
  findLiveDeviceCode,
  insertCrosspointDevice,
  restoreDeviceCode,
} from '@/libs/crosspointQueries';

// POST /api/crosspoint/device/token {device_code} — poll a reader sign-in.
// Answers like an OAuth device access token request: 400 authorization_pending
// until the owner approves the code, then the reader's own key, once.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const deviceCode = (body as { device_code?: unknown } | null)?.device_code;
  if (typeof deviceCode !== 'string' || !deviceCode) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  }

  const codeHash = await sha256Hex(deviceCode);
  const now = new Date().toISOString();
  try {
    return await withDb(async (db) => {
      // Deleting the approved sign-in claims it, so only one poll mints a key.
      const approved = await claimApprovedDeviceCode(db, codeHash, now);
      if (!approved) {
        const pending = await findLiveDeviceCode(db, codeHash, now);
        return NextResponse.json(
          { error: pending ? 'authorization_pending' : 'expired_token' },
          { status: 400 },
        );
      }

      const key = newSecret();
      let device: { id: string } | null;
      try {
        device = await insertCrosspointDevice(db, approved.userId, await hashDeviceKey(key));
      } catch (error) {
        // Put the approval back, so the reader's next poll can still get a key.
        await restoreDeviceCode(db, { deviceCodeHash: codeHash, ...approved });
        throw error;
      }
      if (!device) {
        await restoreDeviceCode(db, { deviceCodeHash: codeHash, ...approved });
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
      }

      // id lets the plugin revoke the key; username labels the reader's KOReader Sync settings.
      return NextResponse.json({
        access_token: key,
        token_type: 'bearer',
        id: device.id,
        username: approved.username,
      });
    });
  } catch {
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
