import { and, desc, eq, gt, ilike, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Db } from '@/libs/db';
import { schema } from '@/libs/db';

const codes = schema.crosspointDeviceCodes;
const devices = schema.crosspointDevices;

export type ApprovedDeviceCode = {
  userCode: string;
  userId: string;
  username: string | null;
  expiresAt: string;
};

export const purgeExpiredDeviceCodes = (db: Db, now: string) =>
  db.delete(codes).where(lt(codes.expiresAt, now));

export const insertDeviceCode = (
  db: Db,
  row: { deviceCodeHash: string; userCode: string; expiresAt: string },
) => db.insert(codes).values(row);

export const approveDeviceCode = async (
  db: Db,
  args: { userCode: string; userId: string; username: string; now: string },
) => {
  const rows = await db
    .update(codes)
    .set({ userId: args.userId, username: args.username })
    .where(
      and(eq(codes.userCode, args.userCode), isNull(codes.userId), gt(codes.expiresAt, args.now)),
    )
    .returning({ userCode: codes.userCode });
  return rows.length;
};

/** Delete the approved sign-in so only one poll can mint a key. */
export const claimApprovedDeviceCode = async (
  db: Db,
  deviceCodeHash: string,
  now: string,
): Promise<ApprovedDeviceCode | null> => {
  const rows = await db
    .delete(codes)
    .where(
      and(
        eq(codes.deviceCodeHash, deviceCodeHash),
        isNotNull(codes.userId),
        gt(codes.expiresAt, now),
      ),
    )
    .returning({
      userCode: codes.userCode,
      userId: codes.userId,
      username: codes.username,
      expiresAt: codes.expiresAt,
    });
  const row = rows[0];
  if (!row?.userId) return null;
  return {
    userCode: row.userCode,
    userId: row.userId,
    username: row.username,
    expiresAt: row.expiresAt,
  };
};

export const findLiveDeviceCode = async (db: Db, deviceCodeHash: string, now: string) => {
  const rows = await db
    .select({ expiresAt: codes.expiresAt })
    .from(codes)
    .where(and(eq(codes.deviceCodeHash, deviceCodeHash), gt(codes.expiresAt, now)))
    .limit(1);
  return rows[0] ?? null;
};

export const insertCrosspointDevice = async (db: Db, userId: string, keyHash: string) => {
  const rows = await db.insert(devices).values({ userId, keyHash }).returning({ id: devices.id });
  return rows[0] ?? null;
};

export const restoreDeviceCode = (db: Db, row: ApprovedDeviceCode & { deviceCodeHash: string }) =>
  db.insert(codes).values(row);

export const userIdForDeviceKeyHash = async (db: Db, keyHash: string) => {
  const rows = await db
    .select({ userId: devices.userId })
    .from(devices)
    .where(eq(devices.keyHash, keyHash))
    .limit(1);
  return rows[0]?.userId ?? null;
};

export const revokeCrosspointDevice = (db: Db, id: string) =>
  db.delete(devices).where(eq(devices.id, id));

export type CatalogBook = {
  bookHash: string;
  title: string | null;
  author: string | null;
};

export const listUploadedEpubs = (
  db: Db,
  args: { userId: string; offset: number; limit: number; q: string },
) => {
  const filters = [
    eq(schema.books.userId, args.userId),
    eq(schema.books.format, 'EPUB'),
    isNull(schema.books.deletedAt),
    isNotNull(schema.books.uploadedAt),
  ];
  if (args.q) {
    const pattern = `%${args.q}%`;
    filters.push(or(ilike(schema.books.title, pattern), ilike(schema.books.author, pattern))!);
  }
  return db
    .select({
      bookHash: schema.books.bookHash,
      title: schema.books.title,
      author: schema.books.author,
    })
    .from(schema.books)
    .where(and(...filters))
    .orderBy(desc(schema.books.updatedAt), schema.books.bookHash)
    .offset(args.offset)
    .limit(args.limit);
};

export const liveFileKeys = (db: Db, userId: string, bookHash: string) =>
  db
    .select({ fileKey: schema.files.fileKey })
    .from(schema.files)
    .where(
      and(
        eq(schema.files.userId, userId),
        eq(schema.files.bookHash, bookHash),
        isNull(schema.files.deletedAt),
      ),
    );

export type BookConfigProgress = {
  xpointer: string | null;
  progress: unknown;
  updatedAt: string | null;
};

export const readBookConfig = async (
  db: Db,
  userId: string,
  bookHash: string,
  liveOnly: boolean,
): Promise<BookConfigProgress | null> => {
  const rows = await db
    .select({
      xpointer: schema.bookConfigs.xpointer,
      progress: schema.bookConfigs.progress,
      updatedAt: schema.bookConfigs.updatedAt,
    })
    .from(schema.bookConfigs)
    .where(
      and(
        eq(schema.bookConfigs.userId, userId),
        eq(schema.bookConfigs.bookHash, bookHash),
        liveOnly ? isNull(schema.bookConfigs.deletedAt) : undefined,
      ),
    )
    .limit(1);
  return rows[0] ?? null;
};

export type StatPageRow = {
  userId: string;
  bookHash: string;
  page: number;
  startTime: number;
  duration: number;
  totalPages: number;
};

export const insertStatPages = (db: Db, rows: StatPageRow[]) =>
  db
    .insert(schema.statPages)
    .values(rows)
    .onConflictDoNothing({
      target: [
        schema.statPages.userId,
        schema.statPages.bookHash,
        schema.statPages.page,
        schema.statPages.startTime,
      ],
    });

export const updateBookConfigProgress = (
  db: Db,
  args: {
    userId: string;
    bookHash: string;
    xpointer: string;
    progress: [number, number];
    updatedAt: string;
  },
) =>
  db
    .update(schema.bookConfigs)
    .set({ xpointer: args.xpointer, progress: args.progress, updatedAt: args.updatedAt })
    .where(
      and(
        eq(schema.bookConfigs.userId, args.userId),
        eq(schema.bookConfigs.bookHash, args.bookHash),
        lt(schema.bookConfigs.updatedAt, args.updatedAt),
      ),
    );

export const insertBookConfigProgress = (
  db: Db,
  args: {
    userId: string;
    bookHash: string;
    xpointer: string;
    progress: [number, number];
    updatedAt: string;
  },
) =>
  db
    .insert(schema.bookConfigs)
    .values({
      userId: args.userId,
      bookHash: args.bookHash,
      xpointer: args.xpointer,
      progress: args.progress,
      updatedAt: args.updatedAt,
    })
    .onConflictDoNothing({ target: [schema.bookConfigs.userId, schema.bookConfigs.bookHash] });

export const updateBookLibraryProgress = (
  db: Db,
  args: { userId: string; bookHash: string; progress: [number, number]; updatedAt: string },
) =>
  db
    .update(schema.books)
    .set({ progress: args.progress, updatedAt: args.updatedAt })
    .where(
      and(
        eq(schema.books.userId, args.userId),
        eq(schema.books.bookHash, args.bookHash),
        lt(schema.books.updatedAt, args.updatedAt),
      ),
    );
