import { type SQL, and, asc, count, desc, eq, ilike, inArray, isNull } from 'drizzle-orm';
import type { NextApiRequest, NextApiResponse } from 'next';
import { validateUserAndToken } from '@/libs/auth/verify';
import { schema, withDb } from '@/libs/db';
import { corsAllMethods, runMiddleware } from '@/utils/cors';

interface FileRecord {
  file_key: string;
  file_size: number;
  book_hash: string | null;
  replica_kind: string | null;
  replica_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

interface ListFilesResponse {
  files: FileRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

// A listing request costs about a second almost regardless of how many rows it
// returns, so a client walking the whole account (the calibre plugin) pays per
// page. 1000 turns ~16 requests into 2. The in-app Storage Manager asks for 20
// and is unaffected.
export const MAX_PAGE_SIZE = 1000;

export const resolvePageSize = (raw: string | undefined) =>
  Math.max(1, Math.min(parseInt(raw as string) || 50, MAX_PAGE_SIZE));

// snake_case because this is the wire format the calibre plugin reads.
const columns = {
  file_key: schema.files.fileKey,
  file_size: schema.files.fileSize,
  book_hash: schema.files.bookHash,
  replica_kind: schema.files.replicaKind,
  replica_id: schema.files.replicaId,
  created_at: schema.files.createdAt,
  updated_at: schema.files.updatedAt,
};

const SORT_COLUMNS = {
  created_at: schema.files.createdAt,
  updated_at: schema.files.updatedAt,
  file_size: schema.files.fileSize,
  file_key: schema.files.fileKey,
} as const;

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  await runMiddleware(req, res, corsAllMethods);

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    return await withDb(async (db) => {
      const { user, token } = await validateUserAndToken(db, req.headers['authorization']);
      if (!user || !token) {
        return res.status(403).json({ error: 'Not authenticated' });
      }

      const reqQuery = req.query as {
        page?: string;
        pageSize?: string;
        sortBy?: string;
        sortOrder?: string;
        bookHash?: string;
        search?: string;
      };
      const page = parseInt(reqQuery.page as string) || 1;
      const pageSize = resolvePageSize(reqQuery.pageSize);
      const sortColumn =
        SORT_COLUMNS[reqQuery.sortBy as keyof typeof SORT_COLUMNS] ?? columns.created_at;
      const sortOrder = reqQuery.sortOrder === 'asc' ? asc : desc;
      const { bookHash, search } = reqQuery;

      const live = [eq(schema.files.userId, user.id), isNull(schema.files.deletedAt)];
      if (bookHash) live.push(eq(schema.files.bookHash, bookHash));
      // `ilike` escapes its argument, so a `%` in the search text matches a
      // literal `%` rather than widening the pattern.
      if (search) live.push(ilike(schema.files.fileKey, `%${search}%`));
      const where = and(...live);

      let total: number;
      let files: FileRecord[];
      try {
        const [totals] = await db.select({ value: count() }).from(schema.files).where(where);
        total = totals?.value ?? 0;

        files = await db
          .select(columns)
          .from(schema.files)
          .where(where)
          .orderBy(sortOrder(sortColumn))
          .limit(pageSize)
          .offset((page - 1) * pageSize);
      } catch (error) {
        console.error('Error querying files:', error);
        return res.status(500).json({ error: 'Failed to retrieve files' });
      }

      // Pull every file that shares a group with the paginated results so
      // groups (book or replica) appear complete in the UI — covers, mdds,
      // etc. that wouldn't match a search filter still ride along.
      // IMPORTANT: the search filter is deliberately not applied here.
      const bookHashes = unique(files.map((f) => f.book_hash));
      const replicaIds = unique(files.map((f) => f.replica_id));
      let allRelatedFiles = files;
      if (bookHashes.length > 0 || replicaIds.length > 0) {
        const scope = and(eq(schema.files.userId, user.id), isNull(schema.files.deletedAt));
        const fileMap = new Map(files.map((f) => [f.file_key, f]));
        const absorb = async (match: SQL) => {
          const rows = await db.select(columns).from(schema.files).where(and(scope, match));
          rows.forEach((f) => fileMap.set(f.file_key, f));
        };
        try {
          if (bookHashes.length > 0) {
            await absorb(inArray(schema.files.bookHash, bookHashes));
          }
          if (replicaIds.length > 0) {
            await absorb(inArray(schema.files.replicaId, replicaIds));
          }
          allRelatedFiles = Array.from(fileMap.values());
        } catch (error) {
          // The expansion is cosmetic: without it a group renders with only
          // the rows the page already found.
          console.error('Error expanding file groups:', error);
        }
      }

      const response: ListFilesResponse = {
        files: allRelatedFiles,
        total,
        page,
        pageSize,
        totalPages: Math.ceil(total / pageSize),
      };

      return res.status(200).json(response);
    });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Something went wrong' });
  }
}

const unique = (values: (string | null)[]): string[] =>
  Array.from(new Set(values.filter((value): value is string => !!value)));
