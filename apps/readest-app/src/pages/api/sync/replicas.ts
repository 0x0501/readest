import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest, NextResponse } from 'next/server';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { validateUserAndToken } from '@/libs/auth/verify';
import { type Db, schema, withDb } from '@/libs/db';
import { runMiddleware, corsAllMethods } from '@/utils/cors';
import { validatePullBatch, validatePullParams, validatePushBatch } from '@/libs/replicaSyncServer';
import type { ReplicaRow } from '@/types/replica';

const errorResponse = (status: number, code: string, message: string, offendingIndex?: number) =>
  NextResponse.json(
    {
      error: message,
      code,
      ...(typeof offendingIndex === 'number' ? { offendingIndex } : {}),
    },
    { status },
  );

// The wire format is snake_case; Drizzle's is camelCase.
const replicaColumns = {
  user_id: schema.replicas.userId,
  kind: schema.replicas.kind,
  replica_id: schema.replicas.replicaId,
  fields_jsonb: schema.replicas.fieldsJsonb,
  manifest_jsonb: schema.replicas.manifestJsonb,
  deleted_at_ts: schema.replicas.deletedAtTs,
  reincarnation: schema.replicas.reincarnation,
  updated_at_ts: schema.replicas.updatedAtTs,
  schema_version: schema.replicas.schemaVersion,
};

// Scoped by user_id, which is the whole of the authorization now that RLS is
// not enforcing it (ADR-005).
// `Hlc` is a branded string and the jsonb columns are `unknown` at the driver
// boundary; the brands are an application invariant the database does not
// carry, so the shape is asserted here exactly as it was off PostgREST.
const pullReplicas = async (
  db: Db,
  userId: string,
  kind: string,
  since: string | null,
): Promise<ReplicaRow[]> =>
  (await db
    .select(replicaColumns)
    .from(schema.replicas)
    .where(
      and(
        eq(schema.replicas.userId, userId),
        eq(schema.replicas.kind, kind),
        since ? gt(schema.replicas.updatedAtTs, since) : undefined,
      ),
    )
    .orderBy(asc(schema.replicas.updatedAtTs))
    .limit(1000)) as unknown as ReplicaRow[];

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

    // Body discriminator: `{ cursors: [...] }` is a batched pull (replaces
    // N parallel `GET ?kind=K&since=…` calls with a single Worker
    // invocation); `{ rows: [...] }` is the existing push.
    if (typeof body === 'object' && body !== null && 'cursors' in body) {
      const validation = validatePullBatch(body);
      if (!validation.ok) {
        return errorResponse(
          validation.status,
          validation.code,
          validation.message,
          validation.offendingIndex,
        );
      }
      const { cursors } = validation.params;
      if (cursors.length === 0) {
        return NextResponse.json({ results: [] }, { status: 200 });
      }
      // Per-kind queries run in parallel: each is the same SELECT the
      // single-kind GET issues, just dispatched together, collapsing N Worker
      // invocations into 1. They share one connection, so Postgres runs them in
      // sequence — the saving is round trips to the Worker, not database load.
      try {
        const results = await Promise.all(
          cursors.map(async ({ kind, since }) => ({
            kind,
            rows: await pullReplicas(db, user.id, kind, since),
          })),
        );
        return NextResponse.json({ results }, { status: 200 });
      } catch (error) {
        console.error('batch pull replicas failed', { cursors, error });
        const message = error instanceof Error ? error.message : 'unknown error';
        return errorResponse(500, 'SERVER', message);
      }
    }

    const validation = validatePushBatch(body, user.id, Date.now());
    if (!validation.ok) {
      return errorResponse(
        validation.status,
        validation.code,
        validation.message,
        validation.offendingIndex,
      );
    }

    // `crdt_merge_replica` takes the owner as a parameter rather than reading
    // `auth.uid()`, and `validatePushBatch` has already pinned every row's
    // `user_id` to the caller — so no session context is needed here.
    const merged: ReplicaRow[] = [];
    for (const row of validation.rows) {
      try {
        const result = await db.execute(sql`
        select * from public.crdt_merge_replica(
          ${row.user_id}::uuid,
          ${row.kind},
          ${row.replica_id},
          ${JSON.stringify(row.fields_jsonb)}::jsonb,
          ${row.manifest_jsonb === null ? null : JSON.stringify(row.manifest_jsonb)}::jsonb,
          ${row.deleted_at_ts},
          ${row.reincarnation},
          ${row.updated_at_ts},
          ${row.schema_version}
        )
      `);
        const data = result.rows[0] as unknown as ReplicaRow | undefined;
        if (data) merged.push(data);
      } catch (error) {
        console.error('crdt_merge_replica failed', { row, error });
        return errorResponse(
          500,
          'SERVER',
          error instanceof Error ? error.message : 'Merge failed',
        );
      }
    }

    return NextResponse.json({ rows: merged }, { status: 200 });
  });
}

export async function GET(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return errorResponse(401, 'AUTH', 'Not authenticated');
    }

    const { searchParams } = new URL(req.url);
    const validation = validatePullParams(searchParams.get('kind'), searchParams.get('since'));
    if (!validation.ok) {
      return errorResponse(validation.status, validation.code, validation.message);
    }
    const { kind, since } = validation.params;

    try {
      const rows = await pullReplicas(db, user.id, kind, since);
      return NextResponse.json({ rows }, { status: 200 });
    } catch (error) {
      console.error('pull replicas failed', { kind, since, error });
      return errorResponse(500, 'SERVER', error instanceof Error ? error.message : 'Pull failed');
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
    } else {
      res.setHeader('Allow', ['GET', 'POST']);
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
    console.error('Error processing /api/sync/replicas request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export default handler;
