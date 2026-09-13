import { and, asc, desc, eq, getTableColumns, gt, inArray, lt, or, sql } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { NextApiRequest, NextApiResponse } from 'next';
import { NextRequest, NextResponse } from 'next/server';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { BookDataRecord } from '@/types/book';
import { transformBookConfigToDB } from '@/utils/transform';
import { transformBookNoteToDB } from '@/utils/transform';
import { transformBookToDB } from '@/utils/transform';
import { runMiddleware, corsAllMethods } from '@/utils/cors';
import {
  SyncData,
  SyncRecord,
  SyncResult,
  SyncType,
  StatBookRecord,
  StatPageRecord,
} from '@/libs/sync';
import { DBBook, DBBookConfig } from '@/types/records';
import { clientSafeMessage, describeError, SyncError } from '@/libs/errors';

const ms = (s?: string | number | null) => (s ? new Date(s).getTime() : 0);

/**
 * Field-level last-writer-wins for a books row's reading_status: return the
 * status fields with the newer reading_status_updated_at (ties → client). NULL
 * timestamp = epoch 0. Lets reading_status survive even when the whole row is
 * decided the other way by updated_at (which page-turn progress dominates) —
 * issue #4634.
 */
/**
 * `undefined` (the client omitted reading_status entirely — e.g. a locally
 * imported book that never had a status set) and `null` (the DB default) both
 * mean "no reading status". Collapse them so a statusless book never registers
 * as a status change. Without this, the `statusChanged` branch below rewrites
 * `updated_at = now()` on every push for such books, and since the 1-day
 * re-sync window re-pushes recently-touched books each cycle, they get a fresh
 * timestamp every sync and pin themselves to the top of the date-sorted
 * library.
 */
export const readingStatusChanged = (client?: string | null, server?: string | null): boolean =>
  (client ?? null) !== (server ?? null);

export function resolveReadingStatusMerge(
  client: Pick<DBBook, 'reading_status' | 'reading_status_updated_at'>,
  server: Pick<DBBook, 'reading_status' | 'reading_status_updated_at'>,
): Pick<DBBook, 'reading_status' | 'reading_status_updated_at'> {
  return ms(client.reading_status_updated_at) >= ms(server.reading_status_updated_at)
    ? {
        reading_status: client.reading_status,
        reading_status_updated_at: client.reading_status_updated_at,
      }
    : {
        reading_status: server.reading_status,
        reading_status_updated_at: server.reading_status_updated_at,
      };
}

/**
 * Build the row written when the server wins a books row by `updated_at` but
 * the client's reading_status is the fresher one: graft the status onto the
 * server row and leave everything else — crucially `updated_at` — untouched.
 *
 * The `books_set_synced_at` trigger stamps `synced_at = now()` on this write,
 * so peers re-pull the status change via the synced_at cursor without the
 * date-read library (sorted by updated_at) jumping to sync-processing time.
 * Previously this rewrote `updated_at = now()` to force propagation, which was
 * the #4677 reorder symptom. See issue #4678.
 */
export function buildStatusPropagationRow(
  serverBook: DBBook,
  status: Pick<DBBook, 'reading_status' | 'reading_status_updated_at'>,
): DBBook {
  return {
    ...serverBook,
    reading_status: status.reading_status,
    reading_status_updated_at: status.reading_status_updated_at,
  };
}

/**
 * Field-level last-writer-wins for a books row's cover: return the
 * {cover_hash, cover_updated_at} with the newer cover_updated_at (ties →
 * client). NULL timestamp = epoch 0. A cover edit shares the row with
 * page-turn progress, so this lets the cover survive even when the whole row
 * is decided the other way by updated_at — the same #4634 hazard the
 * reading_status merge addresses (issue #4544).
 */
export function resolveCoverMerge(
  client: Pick<DBBook, 'cover_hash' | 'cover_updated_at'>,
  server: Pick<DBBook, 'cover_hash' | 'cover_updated_at'>,
): Pick<DBBook, 'cover_hash' | 'cover_updated_at'> {
  return ms(client.cover_updated_at) >= ms(server.cover_updated_at)
    ? { cover_hash: client.cover_hash, cover_updated_at: client.cover_updated_at }
    : { cover_hash: server.cover_hash, cover_updated_at: server.cover_updated_at };
}

type BookMetadataFields = Pick<
  DBBook,
  'title' | 'author' | 'tags' | 'metadata' | 'metadata_updated_at'
>;

const pickMetadataFields = (b: BookMetadataFields): BookMetadataFields => ({
  title: b.title,
  author: b.author,
  tags: b.tags,
  metadata: b.metadata,
  metadata_updated_at: b.metadata_updated_at,
});

/**
 * Field-level last-writer-wins for a books row's metadata group (title,
 * author, tags, metadata): return the side with the newer
 * metadata_updated_at. A metadata edit shares the row with page-turn progress
 * (which dominates updated_at), so the group must resolve on its own clock or
 * a device that read the book after the edit clobbers it — the same #4634 /
 * #4544 hazard, issue #5438. Unlike status/cover, a tie — notably the
 * unstamped legacy 0/0 case — follows the ROW winner: legacy rows keep their
 * historical whole-row behavior instead of letting any stale push graft its
 * metadata onto a newer server row.
 */
export function resolveMetadataMerge(
  client: BookMetadataFields,
  server: BookMetadataFields,
  clientRowWins: boolean,
): BookMetadataFields {
  const clientMs = ms(client.metadata_updated_at);
  const serverMs = ms(server.metadata_updated_at);
  const clientWins = clientMs === serverMs ? clientRowWins : clientMs > serverMs;
  const winner = clientWins ? client : server;
  const loser = clientWins ? server : client;
  const fields = pickMetadataFields(winner);
  // An absent `metadata` blob means "this device never had one" — a cloud-shelf
  // row, a file-sync discovery row, an old client — never "the user cleared
  // it": nothing in the app empties book.metadata, the editor only edits fields
  // inside it. So it must never overwrite a copy that has one, on any clock.
  // Without this a metadata-less peer erased every book's description for the
  // whole fleet (#5912). title/author are NOT NULL columns and need no such
  // guard.
  fields.metadata = fields.metadata ?? loser.metadata;
  return fields;
}

/**
 * Value-level change check for the propagation no-op guard: a timestamp-only
 * difference on identical values must not rewrite the server row (mirrors
 * readingStatusChanged / the cover_hash comparison).
 */
export const bookMetadataChanged = (
  a: Omit<BookMetadataFields, 'metadata_updated_at'>,
  b: Omit<BookMetadataFields, 'metadata_updated_at'>,
): boolean =>
  a.title !== b.title ||
  a.author !== b.author ||
  (a.metadata ?? null) !== (b.metadata ?? null) ||
  JSON.stringify(a.tags ?? null) !== JSON.stringify(b.tags ?? null);

type BookGroupFields = Pick<DBBook, 'group_id' | 'group_name' | 'group_updated_at'>;

const pickGroupFields = (b: BookGroupFields): BookGroupFields => ({
  group_id: b.group_id,
  group_name: b.group_name,
  group_updated_at: b.group_updated_at,
});

const hasGroup = (b: BookGroupFields): boolean => !!b.group_id || !!b.group_name;

/**
 * Field-level last-writer-wins for a books row's group membership (group_id +
 * group_name). Grouping shares the row with page-turn progress AND with
 * uploads — `cloudService.uploadBook` bumps updated_at so the fresh
 * uploaded_at reaches peers — so the group must resolve on its own clock or a
 * device holding a never-grouped copy clobbers it. Issue #5911, the same
 * hazard as #4634 / #4544 / #5438.
 *
 * A tie does NOT follow the row winner, unlike the three merges above. On
 * equal stamps the side that HAS a group wins, because an absent group is
 * ambiguous — "never grouped" and "ungrouped by a client too old to stamp"
 * look identical, and every legacy row is unstamped (0 === 0). Only when both
 * sides agree about having a group does the row winner decide. A real removal
 * still propagates: it carries a newer group_updated_at and wins on step one.
 */
export function resolveGroupMerge(
  client: BookGroupFields,
  server: BookGroupFields,
  clientRowWins: boolean,
): BookGroupFields {
  const clientMs = ms(client.group_updated_at);
  const serverMs = ms(server.group_updated_at);
  if (clientMs !== serverMs) return pickGroupFields(clientMs > serverMs ? client : server);
  if (hasGroup(client) !== hasGroup(server)) {
    return pickGroupFields(hasGroup(client) ? client : server);
  }
  return pickGroupFields(clientRowWins ? client : server);
}

/**
 * Value-level change check for the propagation no-op guard: a timestamp-only
 * difference on the same group must not rewrite the server row (mirrors
 * readingStatusChanged / bookMetadataChanged).
 */
export const bookGroupChanged = (
  a: Omit<BookGroupFields, 'group_updated_at'>,
  b: Omit<BookGroupFields, 'group_updated_at'>,
): boolean =>
  (a.group_id ?? null) !== (b.group_id ?? null) ||
  (a.group_name ?? null) !== (b.group_name ?? null);

// Epoch ms of a row's latest change. A delete counts: KOReader's tombstones
// keep the highlight's original updated_at (the plugin never bumps it on
// delete), so ranking rows on updated_at alone puts a tombstone below a live
// duplicate of the same note (issue #5818).
type ChangeStamps = {
  updated_at?: string | number | null;
  deleted_at?: string | number | null;
};
const latestChangeMs = (rec: ChangeStamps) => Math.max(ms(rec.updated_at), ms(rec.deleted_at));

/**
 * Collapse rows sharing `keys` down to the one changed most recently, keeping
 * the input order. The same note can exist under two book_hash values when the
 * two devices hold different copies of a book (meta_hash bridges them); a
 * deletion on either side must win over the stale live duplicate or it never
 * reaches the peer. A tie goes to the tombstone: a delete and an edit in the
 * same millisecond must not resurrect the note.
 */
export function dedupeLatest<T extends ChangeStamps>(records: T[], keys: (keyof T)[]): T[] {
  const keyOf = (rec: T) =>
    keys
      .map((k) => rec[k])
      .filter(Boolean)
      .join('|');
  const latest = new Map<string, { rec: T; at: number }>();
  for (const rec of records) {
    const key = keyOf(rec);
    if (!key) continue;
    const at = latestChangeMs(rec);
    const best = latest.get(key);
    if (!best || at > best.at || (at === best.at && !!rec.deleted_at && !best.rec.deleted_at)) {
      latest.set(key, { rec, at });
    }
  }
  return records.filter((rec) => {
    const key = keyOf(rec);
    return !key || latest.get(key)?.rec === rec;
  });
}

const transformsToDB = {
  books: transformBookToDB,
  book_notes: transformBookNoteToDB,
  book_configs: transformBookConfigToDB,
};

const DBSyncTypeMap = {
  books: 'books',
  book_notes: 'notes',
  book_configs: 'configs',
};

type TableName = keyof typeof transformsToDB;

type DBError = { table: TableName; error: Error };

const TABLES = {
  books: schema.books,
  book_notes: schema.bookNotes,
  book_configs: schema.bookConfigs,
} satisfies Record<TableName, PgTable>;

/**
 * The sync wire format is snake_case and so are the Postgres columns; only
 * Drizzle's TypeScript names are camelCase. Both maps below are derived from the
 * column metadata rather than written out, so neither can drift off the schema
 * the way a hand-kept list would — and every row in and out of this file keeps
 * the shape the clients already speak.
 */
const wireColumns = (table: PgTable) =>
  Object.fromEntries(
    Object.values(getTableColumns(table)).map((column) => [
      column.name,
      // json/jsonb read back through the column object is parsed twice — once by
      // node-postgres and again by Drizzle's mapper. Clients hand us `progress`,
      // `search_config`, `view_settings` and `metadata` already stringified, so
      // the second parse would return an object where the client calls
      // JSON.parse and throws. A raw expression keeps the driver's value, which
      // is exactly what PostgREST handed back.
      isJson(column) ? sql`${column}`.as(column.name) : column,
    ]),
  ) as Record<string, PgColumn>;

const isJson = (column: PgColumn) =>
  column.columnType === 'PgJson' || column.columnType === 'PgJsonb';

const propertyNames = (table: PgTable) =>
  Object.fromEntries(
    Object.entries(getTableColumns(table)).map(([property, column]) => [column.name, property]),
  ) as Record<string, string>;

const WIRE_COLUMNS: Record<TableName, Record<string, PgColumn>> = {
  books: wireColumns(schema.books),
  book_notes: wireColumns(schema.bookNotes),
  book_configs: wireColumns(schema.bookConfigs),
};

const PROPERTY_NAMES: Record<TableName, Record<string, string>> = {
  books: propertyNames(schema.books),
  book_notes: propertyNames(schema.bookNotes),
  book_configs: propertyNames(schema.bookConfigs),
};

const STAT_BOOK_COLUMNS = wireColumns(schema.statBooks);
const STAT_PAGE_COLUMNS = wireColumns(schema.statPages);

const columnsOf = (table: TableName) =>
  getTableColumns(TABLES[table] as PgTable) as Record<string, PgColumn>;
const wireColumnsOf = (table: TableName) => WIRE_COLUMNS[table];
const propertyOf = (table: TableName, wireName: string) => PROPERTY_NAMES[table][wireName]!;

/** A snake_case wire row rekeyed for Drizzle's insert builder. */
const toRow = (table: TableName, row: object) => {
  const properties = PROPERTY_NAMES[table];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const property = properties[key];
    if (property) out[property] = value;
  }
  return out;
};

/**
 * `SET col = excluded.col` for every column the batch carries, which is what
 * PostgREST's upsert did implicitly. Built from the union of the rows' keys
 * because Drizzle inserts DEFAULT for a column some rows omit, and a grafted
 * server row does not carry the same columns as a transformed client one.
 */
const excludedSet = (table: TableName, rows: Record<string, unknown>[], keys: string[]) => {
  const columns = columnsOf(table);
  const properties = new Set<string>();
  for (const row of rows) for (const property of Object.keys(row)) properties.add(property);
  for (const key of keys) properties.delete(key);
  return Object.fromEntries(
    [...properties].map((property) => [property, sql.raw(`excluded."${columns[property]!.name}"`)]),
  );
};

export async function GET(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
    }

    const { searchParams } = new URL(req.url);
    const sinceParam = searchParams.get('since');
    const typeParam = searchParams.get('type') as SyncType | undefined;
    const bookParam = searchParams.get('book');
    const metaHashParam = searchParams.get('meta_hash');
    // Optional page size for `type=stats` and `type=books` (the client-driven paged
    // pull). Absent for old clients, which keep the full-delta response.
    const limitParam = searchParams.get('limit');
    const limit = limitParam ? Math.max(1, Math.floor(Number(limitParam))) : 0;

    if (!sinceParam) {
      return NextResponse.json({ error: 'A "since" query parameter is required' }, { status: 400 });
    }

    const since = new Date(Number(sinceParam));
    if (isNaN(since.getTime())) {
      return NextResponse.json({ error: 'Invalid "since" timestamp' }, { status: 400 });
    }

    const sinceIso = since.toISOString();

    try {
      const results: SyncResult = {
        books: [],
        configs: [],
        notes: [],
        statBooks: [],
        statPages: [],
      };
      const errors: Record<TableName, DBError | null> = {
        books: null,
        book_notes: null,
        book_configs: null,
      };

      // Scoped by user_id, which is the whole of the authorization now that RLS
      // is not enforcing it (ADR-005).
      const scopeOf = (table: TableName) => {
        const cols = columnsOf(table);
        const filters = [eq(cols['userId']!, user.id)];
        if (bookParam && metaHashParam) {
          filters.push(or(eq(cols['bookHash']!, bookParam), eq(cols['metaHash']!, metaHashParam))!);
        } else if (bookParam) {
          filters.push(eq(cols['bookHash']!, bookParam));
        } else if (metaHashParam) {
          filters.push(eq(cols['metaHash']!, metaHashParam));
        }
        return filters;
      };

      const queryTables = async (table: TableName, dedupeKeys?: (keyof BookDataRecord)[]) => {
        const cols = columnsOf(table);

        // books keys the pull on the server-assigned `synced_at` cursor, which a
        // trigger bumps on every write — including deletes — so a server-resolved
        // merge propagates without touching updated_at (the date-read sort key).
        // configs/notes have no server-side merge, so they stay on updated_at and
        // still need the explicit deleted_at clause. See issue #4678.
        const cursor =
          table === 'books'
            ? gt(cols['syncedAt']!, sinceIso)
            : or(gt(cols['updatedAt']!, sinceIso), gt(cols['deletedAt']!, sinceIso))!;
        const cursorColumn = table === 'books' ? cols['syncedAt']! : cols['updatedAt']!;

        // One statement, no offset walk: the loop this replaces existed because
        // PostgREST truncated a response at ~1000 rows.
        const allRecords = (await db
          .select(wireColumnsOf(table))
          .from(TABLES[table])
          .where(and(...scopeOf(table), cursor))
          .orderBy(desc(cursorColumn))) as unknown as SyncRecord[];

        const records =
          dedupeKeys && dedupeKeys.length > 0 ? dedupeLatest(allRecords, dedupeKeys) : allRecords;
        (results as unknown as Record<string, SyncRecord[]>)[DBSyncTypeMap[table]] = records || [];
      };

      // One bounded page of books for the app's and the calibre plugin's
      // client-driven paged pull: a 10k-book delta accumulated into a single
      // response exceeds the Worker's resource limits (CF error 1102). Rows come
      // back ordered by synced_at ASCENDING, and the trailing synced_at
      // millisecond is completed — batch upserts stamp one now() per statement, so
      // rows share boundary timestamps and a strict `> cursor` re-pull would
      // otherwise skip the half of a batch split by the page boundary. A page
      // shorter than `limit` tells the client the delta is exhausted.
      const fetchPagedBooks = async () => {
        const scope = scopeOf('books');
        const rows = (await db
          .select(wireColumnsOf('books'))
          .from(schema.books)
          .where(and(...scope, gt(schema.books.syncedAt, sinceIso)))
          .orderBy(asc(schema.books.syncedAt))
          .limit(limit)) as unknown as SyncRecord[];
        if (rows.length === limit) {
          const lastSynced = (rows[rows.length - 1] as unknown as { synced_at: string }).synced_at;
          const extra = (await db
            .select(wireColumnsOf('books'))
            .from(schema.books)
            .where(
              and(...scope, eq(schema.books.syncedAt, lastSynced)),
            )) as unknown as SyncRecord[];
          const seen = new Set(rows.map((r) => r.book_hash));
          for (const r of extra) {
            if (!seen.has(r.book_hash)) {
              seen.add(r.book_hash);
              rows.push(r);
            }
          }
        }
        results.books = rows;
      };

      if (!typeParam || typeParam === 'books') {
        const booksQuery =
          limit > 0 && typeParam === 'books' ? fetchPagedBooks : () => queryTables('books');
        await booksQuery().catch((err) => (errors['books'] = { table: 'books', error: err }));
        // TODO: Remove this hotfix for the initial race condition of books sync
        if (results.books?.length === 0 && since.getTime() < 1000) {
          const dummyHash = '00000000000000000000000000000000';
          const now = Date.now();
          results.books.push({
            user_id: user.id,
            id: dummyHash,
            book_hash: dummyHash,
            deleted_at: now,
            updated_at: now,

            hash: dummyHash,
            title: 'Dummy Book',
            format: 'EPUB',
            author: '',
            createdAt: now,
            updatedAt: now,
            deletedAt: now,
          });
        }
      }
      if (!typeParam || typeParam === 'configs') {
        await queryTables('book_configs').catch(
          (err) => (errors['book_configs'] = { table: 'book_configs', error: err }),
        );
      }
      if (!typeParam || typeParam === 'notes') {
        await queryTables('book_notes', ['id']).catch(
          (err) => (errors['book_notes'] = { table: 'book_notes', error: err }),
        );
      }
      if (!typeParam || typeParam === 'stats') {
        // Cursor is `updated_at > since` ONLY (no `OR deleted_at > since`). Every
        // stat push server-stamps `updated_at = now()` including deletes (see the
        // upserts below), so a delete always lands with an updated_at greater than
        // any peer's max(updated_at) pull cursor — `updated_at > since` already
        // returns it. The redundant OR made this the #1 query by total DB time: it
        // defeats the (user_id, updated_at) index.
        //
        // Note this differs from the page-event tables above (#4678); here every
        // write is server-stamped.
        const statPagesScope = () =>
          and(
            eq(schema.statPages.userId, user.id),
            gt(schema.statPages.updatedAt, sinceIso),
            bookParam ? eq(schema.statPages.bookHash, bookParam) : undefined,
          );

        // stat_books is always returned in full (one row per book, small); only
        // stat_pages pages when the client asks (the koplugin omits `limit`).
        const statBookRows = await db
          .select(STAT_BOOK_COLUMNS)
          .from(schema.statBooks)
          .where(
            and(eq(schema.statBooks.userId, user.id), gt(schema.statBooks.updatedAt, sinceIso)),
          )
          .orderBy(asc(schema.statBooks.updatedAt));

        // A single bounded page of stat_pages for the app's client-driven paged
        // pull, with the trailing updated_at millisecond completed so the client
        // can advance its cursor with a strict `>` without skipping ties.
        const fetchPagedPages = async () => {
          const rows = await db
            .select(STAT_PAGE_COLUMNS)
            .from(schema.statPages)
            .where(statPagesScope())
            .orderBy(asc(schema.statPages.updatedAt))
            .limit(limit);
          if (rows.length === limit) {
            const lastUpdated = rows[rows.length - 1]!['updated_at'] as unknown as string;
            const extra = await db
              .select(STAT_PAGE_COLUMNS)
              .from(schema.statPages)
              .where(
                and(
                  eq(schema.statPages.userId, user.id),
                  eq(schema.statPages.updatedAt, lastUpdated),
                  bookParam ? eq(schema.statPages.bookHash, bookParam) : undefined,
                ),
              );
            const keyOf = (r: Record<string, unknown>) =>
              `${r['book_hash']}|${r['page']}|${r['start_time']}`;
            const seen = new Set(rows.map(keyOf));
            for (const r of extra) {
              const k = keyOf(r);
              if (!seen.has(k)) {
                seen.add(k);
                rows.push(r);
              }
            }
          }
          return rows;
        };

        const statPageRows =
          limit > 0
            ? await fetchPagedPages()
            : await db
                .select(STAT_PAGE_COLUMNS)
                .from(schema.statPages)
                .where(statPagesScope())
                .orderBy(asc(schema.statPages.updatedAt));

        // Attach updated_at_ms (epoch ms) so non-JS clients (the Lua koplugin) can
        // compute their pull cursor without parsing ISO-8601 timestamps.
        const withMs = <T extends { updated_at?: string }>(rows: T[]) =>
          rows.map((r) => ({
            ...r,
            updated_at_ms: r.updated_at ? new Date(r.updated_at).getTime() : 0,
          }));

        results.statBooks = withMs(statBookRows as unknown as StatBookRecord[]);
        results.statPages = withMs(statPageRows as unknown as StatPageRecord[]);
      }

      const dbErrors = Object.values(errors).filter((err) => err !== null);
      if (dbErrors.length > 0) {
        console.error('Errors occurred:', dbErrors);
        const errorMsg = dbErrors
          .map((err) => `${err.table}: ${err.error.message || 'Unknown error'}`)
          .join('; ');
        return NextResponse.json({ error: errorMsg }, { status: 500 });
      }

      const response = NextResponse.json(results, { status: 200 });
      response.headers.set('Cache-Control', 'no-store');
      response.headers.set('Pragma', 'no-cache');
      response.headers.delete('ETag');
      return response;
    } catch (error: unknown) {
      console.error('sync request failed:', describeError(error));
      const errorMessage = clientSafeMessage(error, 'Unknown error');
      return NextResponse.json({ error: errorMessage }, { status: 500 });
    }
  });
}

export async function POST(req: NextRequest) {
  return withDb(async (db) => {
    const { user, token } = await validateUserAndToken(db, req.headers.get('authorization'));
    if (!user || !token) {
      return NextResponse.json({ error: 'Not authenticated' }, { status: 403 });
    }
    const body = await req.json();
    const {
      books = [],
      configs = [],
      notes = [],
      statBooks = [],
      statPages = [],
    } = body as SyncData;

    const BATCH_SIZE = 100;
    const upsertRecords = async (
      table: TableName,
      primaryKeys: (keyof BookDataRecord)[],
      records: BookDataRecord[],
    ) => {
      if (records.length === 0) return { data: [] };

      const cols = columnsOf(table);
      const keyProps = primaryKeys.map((pk) => propertyOf(table, pk as string));
      const allAuthoritativeRecords: BookDataRecord[] = [];

      // Process in batches
      for (let i = 0; i < records.length; i += BATCH_SIZE) {
        const batch = records.slice(i, i + BATCH_SIZE);

        // Transform all records to DB format
        const dbRecords = batch.map((rec) => {
          const dbRec = transformsToDB[table](rec, user.id);
          rec.user_id = user.id;
          rec.book_hash = dbRec.book_hash;
          return { original: rec, db: dbRec };
        });

        // Existing rows for this batch. One IN list per key column is a superset
        // of the key tuples when there are two of them (book_notes), which is
        // harmless: the map below is keyed on the exact tuple, so the extra rows
        // are never matched. PostgREST needed an `or(and(...))` string naming
        // every row individually.
        const keyFilters = primaryKeys.map((pk, idx) =>
          inArray(cols[keyProps[idx]!]!, [
            ...new Set(dbRecords.map(({ original }) => original[pk] as string)),
          ]),
        );
        const serverRecords = (await db
          .select(wireColumnsOf(table))
          .from(TABLES[table])
          .where(and(eq(cols['userId']!, user.id), ...keyFilters))) as unknown as BookDataRecord[];

        // Create lookup map
        const serverRecordsMap = new Map<string, BookDataRecord>();
        serverRecords.forEach((record) => {
          const key = primaryKeys.map((pk) => record[pk]).join('|');
          serverRecordsMap.set(key, record);
        });

        // Separate into inserts and updates
        const toInsert: (DBBook | DBBookConfig | DBBookConfig)[] = [];
        const toUpdate: (DBBook | DBBookConfig | DBBookConfig)[] = [];
        const batchAuthoritativeRecords: BookDataRecord[] = [];

        for (const { original, db: dbRec } of dbRecords) {
          const key = primaryKeys.map((pk) => original[pk]).join('|');
          const serverData = serverRecordsMap.get(key);

          if (!serverData) {
            dbRec.updated_at = new Date().toISOString();
            toInsert.push(dbRec);
          } else {
            const clientUpdatedAt = dbRec.updated_at ? new Date(dbRec.updated_at).getTime() : 0;
            const serverUpdatedAt = serverData.updated_at
              ? new Date(serverData.updated_at).getTime()
              : 0;
            const clientDeletedAt = dbRec.deleted_at ? new Date(dbRec.deleted_at).getTime() : 0;
            const serverDeletedAt = serverData.deleted_at
              ? new Date(serverData.deleted_at).getTime()
              : 0;
            const clientIsNewer =
              clientDeletedAt > serverDeletedAt || clientUpdatedAt > serverUpdatedAt;

            if (table === 'books') {
              // `dbRec` is DBBook | DBBookConfig; in the 'books' branch it is always DBBook.
              const clientBook = dbRec as DBBook;
              // `serverData` is BookDataRecord but the DB row carries the status +
              // cover columns at runtime — widen the type without going through `unknown`.
              const serverBook = serverData as BookDataRecord &
                Partial<
                  Pick<
                    DBBook,
                    | 'reading_status'
                    | 'reading_status_updated_at'
                    | 'cover_hash'
                    | 'cover_updated_at'
                    | 'metadata'
                    | 'metadata_updated_at'
                  >
                > &
                Pick<DBBook, 'title' | 'author' | 'tags'>;
              const status = resolveReadingStatusMerge(clientBook, serverBook);
              // Cover has its own field-level LWW so a page-turn can't clobber a
              // cover edit (issue #4544; mirrors reading_status / #4634).
              const cover = resolveCoverMerge(clientBook, serverBook);
              // The metadata group likewise merges on its own clock (issue #5438).
              const meta = resolveMetadataMerge(clientBook, serverBook, clientIsNewer);
              if (clientIsNewer) {
                // Client wins the row; graft the fresher status + cover +
                // metadata onto it (server's may be the newer one even though
                // the row is older).
                clientBook.reading_status = status.reading_status;
                clientBook.reading_status_updated_at = status.reading_status_updated_at;
                clientBook.cover_hash = cover.cover_hash;
                clientBook.cover_updated_at = cover.cover_updated_at;
                clientBook.title = meta.title;
                clientBook.author = meta.author;
                clientBook.tags = meta.tags;
                clientBook.metadata = meta.metadata;
                clientBook.metadata_updated_at = meta.metadata_updated_at;
                toUpdate.push(clientBook);
              } else {
                // Only rewrite when a resolved field VALUE differs from the
                // server's — a timestamp-only difference on the same value is a
                // no-op, and rewriting it would churn updated_at + re-propagate.
                const statusChanged = readingStatusChanged(
                  status.reading_status,
                  serverBook.reading_status,
                );
                const coverChanged = (cover.cover_hash ?? null) !== (serverBook.cover_hash ?? null);
                const metadataChanged = bookMetadataChanged(meta, serverBook);
                if (statusChanged || coverChanged || metadataChanged) {
                  // Server wins the row, but the client's status, cover and/or
                  // metadata is the fresher one. Graft the fresher fields onto
                  // the server row and leave updated_at untouched; the
                  // books_set_synced_at trigger advances synced_at so peers
                  // re-pull via the synced_at cursor without reordering the
                  // date-read library (#4678, #4544, #5438).
                  // The runtime DB row carries all DBBook columns; the static type
                  // of `serverBook` is a narrower intersection so `unknown` is
                  // required to bridge the gap at this one construction site.
                  const propagated = buildStatusPropagationRow(
                    serverBook as unknown as DBBook,
                    status,
                  );
                  propagated.cover_hash = cover.cover_hash;
                  propagated.cover_updated_at = cover.cover_updated_at;
                  propagated.title = meta.title;
                  propagated.author = meta.author;
                  propagated.tags = meta.tags;
                  propagated.metadata = meta.metadata;
                  propagated.metadata_updated_at = meta.metadata_updated_at;
                  toUpdate.push(propagated);
                } else {
                  batchAuthoritativeRecords.push(serverData);
                }
              }
            } else if (clientIsNewer) {
              toUpdate.push(dbRec);
            } else {
              batchAuthoritativeRecords.push(serverData);
            }
          }
        }

        // Batch insert
        if (toInsert.length > 0) {
          try {
            const inserted = (await db
              .insert(TABLES[table])
              // Drizzle types `.values()` off the concrete table, and this one is a
              // union of three; the rows are built from that same table's columns.
              .values(toInsert.map((row) => toRow(table, row)) as never)
              .returning(wireColumnsOf(table))) as unknown as BookDataRecord[];
            batchAuthoritativeRecords.push(...inserted);
          } catch (error) {
            // The reason has to be logged here: the caller is told something
            // deliberately vague, and the rethrow above this carries only that
            // vague message. Row keys rather than the rows themselves — the
            // payload is the reader's own library, and this is the last place
            // it should be copied into a log.
            console.error(
              `Failed to insert ${table} records`,
              { keys: toInsert.map((row) => (row as { book_hash?: string }).book_hash) },
              describeError(error),
            );
            return { error: clientSafeMessage(error, 'Insert failed') };
          }
        }

        // Batch upsert
        if (toUpdate.length > 0) {
          const rows = toUpdate.map((row) => toRow(table, row));
          try {
            const updated = (await db
              .insert(TABLES[table])
              .values(rows as never)
              .onConflictDoUpdate({
                target: [cols['userId']!, ...keyProps.map((prop) => cols[prop]!)],
                set: excludedSet(table, rows, ['userId', ...keyProps]),
              })
              .returning(wireColumnsOf(table))) as unknown as BookDataRecord[];
            batchAuthoritativeRecords.push(...updated);
          } catch (error) {
            console.error(
              `Failed to update ${table} records`,
              { keys: toUpdate.map((row) => (row as { book_hash?: string }).book_hash) },
              describeError(error),
            );
            return { error: clientSafeMessage(error, 'Update failed') };
          }
        }

        allAuthoritativeRecords.push(...batchAuthoritativeRecords);
      }

      return { data: allAuthoritativeRecords };
    };

    try {
      // Sequential rather than concurrent: these share the request's single
      // connection, so Promise.all would only queue them anyway.
      const booksResult = await upsertRecords('books', ['book_hash'], books as BookDataRecord[]);
      const configsResult = await upsertRecords(
        'book_configs',
        ['book_hash'],
        configs as BookDataRecord[],
      );
      const notesResult = await upsertRecords(
        'book_notes',
        ['book_hash', 'id'],
        notes as BookDataRecord[],
      );

      // SyncError rather than Error: `upsertRecords` has already reduced the
      // database's own message to something the caller may see, and the outer
      // handler only forwards a message it can tell was written for them.
      if (booksResult?.error) throw new SyncError('SERVER', booksResult.error);
      if (configsResult?.error) throw new SyncError('SERVER', configsResult.error);
      if (notesResult?.error) throw new SyncError('SERVER', notesResult.error);

      // Piggyback the per-book reading progress from the configs push onto the
      // matching `books` row. Other devices' library pull-to-refresh reads
      // books.progress + books.updated_at, so without this the row would stay
      // stale until the user navigates back to the library and useBooksSync
      // re-pushes. The `updated_at <` predicate keeps last-writer-wins —
      // a concurrent newer books push is never downgraded — and a missing
      // row is a silent no-op (useBooksSync will insert it later).
      type BookProgressUpdate = {
        book_hash: string;
        progress: [number, number];
        updated_at: string;
      };
      const bookProgressUpdates: BookProgressUpdate[] = [];
      for (const rec of (configsResult.data ?? []) as unknown as DBBookConfig[]) {
        if (!rec.book_hash || !rec.updated_at || rec.progress == null) continue;
        let parsed: unknown;
        try {
          parsed = typeof rec.progress === 'string' ? JSON.parse(rec.progress) : rec.progress;
        } catch {
          continue;
        }
        if (
          !Array.isArray(parsed) ||
          parsed.length !== 2 ||
          typeof parsed[0] !== 'number' ||
          typeof parsed[1] !== 'number'
        ) {
          continue;
        }
        bookProgressUpdates.push({
          book_hash: rec.book_hash,
          progress: [parsed[0], parsed[1]],
          updated_at: rec.updated_at,
        });
      }

      for (const u of bookProgressUpdates) {
        try {
          await db
            .update(schema.books)
            .set({ progress: u.progress, updatedAt: u.updated_at })
            .where(
              and(
                eq(schema.books.userId, user.id),
                eq(schema.books.bookHash, u.book_hash),
                lt(schema.books.updatedAt, u.updated_at),
              ),
            );
        } catch (error) {
          // Best-effort: never fail the configs push because of this side
          // effect — useBooksSync will reconcile the row later.
          console.warn('books.progress piggyback failed for', u.book_hash, error);
        }
      }

      if (statBooks.length > 0) {
        const rows = statBooks.map((b: StatBookRecord) => ({
          userId: user.id,
          bookHash: b.book_hash,
          title: b.title,
          authors: b.authors,
          updatedAt: new Date().toISOString(),
          deletedAt: b.deleted_at ?? null,
        }));
        await db
          .insert(schema.statBooks)
          .values(rows)
          .onConflictDoUpdate({
            target: [schema.statBooks.userId, schema.statBooks.bookHash],
            set: {
              title: sql`excluded.title`,
              authors: sql`excluded.authors`,
              updatedAt: sql`excluded.updated_at`,
              deletedAt: sql`excluded.deleted_at`,
            },
          });
      }

      if (statPages.length > 0) {
        // Migration 020's explicit-user RPC is atomic and avoids the old
        // existing-row scan. Migration 019's auth.uid() variant cannot scope
        // this fork's Better Auth requests.
        const BATCH = 500;
        for (let off = 0; off < statPages.length; off += BATCH) {
          const rows = statPages.slice(off, off + BATCH).map((p) => ({
            book_hash: p.book_hash,
            page: p.page,
            start_time: p.start_time,
            duration: p.duration,
            total_pages: p.total_pages,
            ext: p.ext ?? null,
            deleted_at: p.deleted_at ?? null,
          }));
          await db.execute(
            sql`select public.upsert_stat_pages_as(${user.id}::uuid, ${JSON.stringify(rows)}::jsonb)`,
          );
        }
      }

      return NextResponse.json(
        {
          books: booksResult?.data || [],
          configs: configsResult?.data || [],
          notes: notesResult?.data || [],
        },
        { status: 200 },
      );
    } catch (error: unknown) {
      console.error('sync request failed:', describeError(error));
      const errorMessage = clientSafeMessage(error, 'Unknown error');
      return NextResponse.json({ error: errorMessage }, { status: 500 });
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
        body: JSON.stringify(req.body), // Ensure the body is a string
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
    console.error('Error processing request:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
};

export default handler;
