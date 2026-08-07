import { sql } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest, NextResponse } from 'next/server';
import { validateUserAndToken } from '@/libs/auth/verify';
import { withDb } from '@/libs/db';
import { withUserContext } from '@/libs/db/rpc';
import { corsAllMethods, runMiddleware } from '@/utils/cors';
import { clientSafeMessage } from '@/libs/errors';

const SUPPORTED_ALGS = new Set<string>(['pbkdf2-600k-sha256']);

interface ReplicaKeyRpcRow {
  salt_id: string;
  alg: string;
  salt_b64: string;
  created_at: string;
}

interface ReplicaKeyResponseRow {
  saltId: string;
  alg: string;
  salt: string;
  createdAt: string;
}

const errorResponse = (status: number, code: string, message: string) =>
  NextResponse.json({ error: message, code }, { status });

const toResponseRow = (row: ReplicaKeyRpcRow): ReplicaKeyResponseRow => ({
  saltId: row.salt_id,
  alg: row.alg,
  salt: row.salt_b64,
  createdAt: row.created_at,
});

// All three RPCs scope themselves with `auth.uid()`, so each runs inside
// `withUserContext` — the transaction sets the subject claim PostgREST used to
// copy out of the JWT. Their bodies are unchanged (ADR-010).
export async function GET(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return errorResponse(401, 'AUTH', 'Not authenticated');
    }

    try {
      const result = await withUserContext(db, user.id, (tx) =>
        tx.execute(sql`select * from public.replica_keys_list()`),
      );
      const rows = result.rows as unknown as ReplicaKeyRpcRow[];
      return NextResponse.json({ rows: rows.map(toResponseRow) }, { status: 200 });
    } catch (error) {
      console.error('replica_keys_list failed', { userId: user.id, error });
      return errorResponse(500, 'SERVER', clientSafeMessage(error, 'Failed'));
    }
  });
}

export async function POST(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return errorResponse(401, 'AUTH', 'Not authenticated');
    }

    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return errorResponse(400, 'VALIDATION', 'Invalid JSON body');
    }
    const alg =
      typeof body === 'object' && body !== null && 'alg' in body
        ? (body as { alg: unknown }).alg
        : undefined;
    if (typeof alg !== 'string' || !SUPPORTED_ALGS.has(alg)) {
      return errorResponse(422, 'UNSUPPORTED_ALG', `Unsupported alg: ${String(alg)}`);
    }

    try {
      const result = await withUserContext(db, user.id, (tx) =>
        tx.execute(sql`select * from public.replica_keys_create(${alg})`),
      );
      const row = result.rows[0] as unknown as ReplicaKeyRpcRow | undefined;
      if (!row) {
        return errorResponse(500, 'SERVER', 'replica_keys_create returned no row');
      }
      return NextResponse.json({ row: toResponseRow(row) }, { status: 201 });
    } catch (error) {
      console.error('replica_keys_create failed', { userId: user.id, error });
      return errorResponse(500, 'SERVER', clientSafeMessage(error, 'Failed'));
    }
  });
}

export async function DELETE(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return errorResponse(401, 'AUTH', 'Not authenticated');
    }

    try {
      await withUserContext(db, user.id, (tx) =>
        tx.execute(sql`select public.replica_keys_forget()`),
      );
      return NextResponse.json({ ok: true }, { status: 200 });
    } catch (error) {
      console.error('replica_keys_forget failed', { userId: user.id, error });
      return errorResponse(500, 'SERVER', clientSafeMessage(error, 'Failed'));
    }
  });
}

const handler = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!req.url) {
    return res.status(400).json({ error: 'Invalid request URL' });
  }
  const protocol = process.env['PROTOCOL'] || 'http';
  const host = process.env['HOST'] || 'localhost:3000';
  const url = new URL(req.url, `${protocol}://${host}`);

  await runMiddleware(req, res, corsAllMethods);

  try {
    let response: Response;
    if (req.method === 'GET') {
      const nextReq = new NextRequest(url.toString(), {
        headers: new Headers(req.headers as Record<string, string>),
        method: 'GET',
      });
      response = await GET(nextReq);
    } else if (req.method === 'POST') {
      const nextReq = new NextRequest(url.toString(), {
        headers: new Headers(req.headers as Record<string, string>),
        method: 'POST',
        body: JSON.stringify(req.body),
      });
      response = await POST(nextReq);
    } else if (req.method === 'DELETE') {
      const nextReq = new NextRequest(url.toString(), {
        headers: new Headers(req.headers as Record<string, string>),
        method: 'DELETE',
      });
      response = await DELETE(nextReq);
    } else {
      res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
      return res.status(405).json({ error: 'Method Not Allowed' });
    }

    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.send(buffer);
  } catch (error) {
    console.error('Error processing /api/sync/replica-keys request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export default handler;
