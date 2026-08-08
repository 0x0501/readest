import {
  pgTable,
  index,
  foreignKey,
  unique,
  pgPolicy,
  uuid,
  text,
  bigint,
  timestamp,
  integer,
  boolean,
  check,
  primaryKey,
  date,
  jsonb,
  json,
  customType,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const bookShares = pgTable(
  'book_shares',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    tokenHash: text('token_hash').notNull(),
    token: text().notNull(),
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    bookTitle: text('book_title').notNull(),
    bookAuthor: text('book_author'),
    bookFormat: text('book_format').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    bookSize: bigint('book_size', { mode: 'number' }).notNull(),
    cfi: text(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'string' }),
    downloadCount: integer('download_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_book_shares_user_id').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    index('idx_book_shares_user_id_book_hash').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
      table.bookHash.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'book_shares_user_id_fkey',
    }).onDelete('cascade'),
    unique('book_shares_token_hash_key').on(table.tokenHash),
    pgPolicy('book_shares_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('book_shares_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('book_shares_update', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('book_shares_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const files = pgTable(
  'files',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash'),
    fileKey: text('file_key').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    fileSize: bigint('file_size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    replicaKind: text('replica_kind'),
    replicaId: text('replica_id'),
  },
  (table) => [
    index('idx_files_file_key').using('btree', table.fileKey.asc().nullsLast().op('text_ops')),
    index('idx_files_file_key_deleted_at').using(
      'btree',
      table.fileKey.asc().nullsLast().op('timestamptz_ops'),
      table.deletedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('idx_files_replica_lookup').using(
      'btree',
      table.userId.asc().nullsLast().op('text_ops'),
      table.replicaKind.asc().nullsLast().op('text_ops'),
      table.replicaId.asc().nullsLast().op('uuid_ops'),
    ),
    index('idx_files_user_id_deleted_at').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
      table.deletedAt.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'files_user_id_fkey',
    }).onDelete('cascade'),
    unique('files_file_key_key').on(table.fileKey),
    pgPolicy('files_insert', {
      as: 'permissive',
      for: 'insert',
      to: ['public'],
      withCheck: sql`(auth.uid() = user_id)`,
    }),
    pgPolicy('files_select', { as: 'permissive', for: 'select', to: ['public'] }),
    pgPolicy('files_update', { as: 'permissive', for: 'update', to: ['public'] }),
    pgPolicy('files_delete', { as: 'permissive', for: 'delete', to: ['public'] }),
  ],
);

export const sendAddresses = pgTable(
  'send_addresses',
  {
    userId: uuid('user_id').primaryKey().notNull(),
    address: text().notNull(),
    enabled: boolean().default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_send_addresses_address').using(
      'btree',
      table.address.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'send_addresses_user_id_fkey',
    }).onDelete('cascade'),
    unique('send_addresses_address_key').on(table.address),
    pgPolicy('send_addresses_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('send_addresses_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('send_addresses_update', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('send_addresses_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const sendAllowedSenders = pgTable(
  'send_allowed_senders',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    email: text().notNull(),
    status: text().default('approved').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_send_allowed_senders_user').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'send_allowed_senders_user_id_fkey',
    }).onDelete('cascade'),
    unique('send_allowed_senders_user_email_key').on(table.userId, table.email),
    pgPolicy('send_allowed_senders_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('send_allowed_senders_insert', {
      as: 'permissive',
      for: 'insert',
      to: ['authenticated'],
    }),
    pgPolicy('send_allowed_senders_update', {
      as: 'permissive',
      for: 'update',
      to: ['authenticated'],
    }),
    pgPolicy('send_allowed_senders_delete', {
      as: 'permissive',
      for: 'delete',
      to: ['authenticated'],
    }),
    check(
      'send_allowed_senders_status_check',
      sql`status = ANY (ARRAY['approved'::text, 'pending'::text])`,
    ),
  ],
);

export const sendInbox = pgTable(
  'send_inbox',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    userId: uuid('user_id').notNull(),
    kind: text().notNull(),
    source: text().notNull(),
    payloadKey: text('payload_key'),
    url: text(),
    filename: text(),
    subjectTag: text('subject_tag'),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    byteSize: bigint('byte_size', { mode: 'number' }).default(0).notNull(),
    status: text().default('pending').notNull(),
    claimedBy: text('claimed_by'),
    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'string' }),
    attempts: integer().default(0).notNull(),
    error: text(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_send_inbox_user_status').using(
      'btree',
      table.userId.asc().nullsLast().op('text_ops'),
      table.status.asc().nullsLast().op('timestamptz_ops'),
      table.createdAt.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'send_inbox_user_id_fkey',
    }).onDelete('cascade'),
    pgPolicy('send_inbox_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    check(
      'send_inbox_kind_check',
      sql`kind = ANY (ARRAY['file'::text, 'url'::text, 'html'::text])`,
    ),
    check('send_inbox_source_check', sql`source = ANY (ARRAY['email'::text, 'extension'::text])`),
    check(
      'send_inbox_status_check',
      sql`status = ANY (ARRAY['pending'::text, 'claimed'::text, 'done'::text, 'failed'::text])`,
    ),
  ],
);

export const user = pgTable(
  'user',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    emailVerified: boolean().notNull(),
    image: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [unique('user_email_key').on(table.email)],
);

export const session = pgTable(
  'session',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    token: text().notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    ipAddress: text(),
    userAgent: text(),
    userId: uuid().notNull(),
  },
  (table) => [
    index('session_userId_idx').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'session_userId_fkey',
    }).onDelete('cascade'),
    unique('session_token_key').on(table.token),
  ],
);

export const account = pgTable(
  'account',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    accountId: text().notNull(),
    providerId: text().notNull(),
    userId: uuid().notNull(),
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }),
    refreshTokenExpiresAt: timestamp({ withTimezone: true, mode: 'string' }),
    scope: text(),
    password: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('account_userId_idx').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'account_userId_fkey',
    }).onDelete('cascade'),
  ],
);

export const verification = pgTable(
  'verification',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('verification_identifier_idx').using(
      'btree',
      table.identifier.asc().nullsLast().op('text_ops'),
    ),
  ],
);

export const jwks = pgTable('jwks', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  publicKey: text().notNull(),
  privateKey: text().notNull(),
  createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
  expiresAt: timestamp({ withTimezone: true, mode: 'string' }),
});

export const apikey = pgTable(
  'apikey',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    configId: text().notNull(),
    name: text(),
    start: text(),
    referenceId: text().notNull(),
    prefix: text(),
    key: text().notNull(),
    refillInterval: integer(),
    refillAmount: integer(),
    lastRefillAt: timestamp({ withTimezone: true, mode: 'string' }),
    enabled: boolean(),
    rateLimitEnabled: boolean(),
    rateLimitTimeWindow: integer(),
    rateLimitMax: integer(),
    requestCount: integer(),
    remaining: integer(),
    lastRequest: timestamp({ withTimezone: true, mode: 'string' }),
    expiresAt: timestamp({ withTimezone: true, mode: 'string' }),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    updatedAt: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
    permissions: text(),
    metadata: text(),
  },
  (table) => [
    index('apikey_configId_idx').using('btree', table.configId.asc().nullsLast().op('text_ops')),
    index('apikey_key_idx').using('btree', table.key.asc().nullsLast().op('text_ops')),
    index('apikey_referenceId_idx').using(
      'btree',
      table.referenceId.asc().nullsLast().op('text_ops'),
    ),
  ],
);

export const passkey = pgTable(
  'passkey',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    name: text(),
    publicKey: text().notNull(),
    userId: uuid().notNull(),
    credentialID: text().notNull(),
    counter: integer().notNull(),
    deviceType: text().notNull(),
    backedUp: boolean().notNull(),
    transports: text(),
    createdAt: timestamp({ withTimezone: true, mode: 'string' }),
    aaguid: text(),
  },
  (table) => [
    index('passkey_credentialID_idx').using(
      'btree',
      table.credentialID.asc().nullsLast().op('text_ops'),
    ),
    index('passkey_userId_idx').using('btree', table.userId.asc().nullsLast().op('uuid_ops')),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'passkey_userId_fkey',
    }).onDelete('cascade'),
  ],
);

// Better Auth rate-limit counters (historical ADR-020). Runtime no longer
// writes here (ADR-021); table retained for migration history.
export const rateLimit = pgTable('rateLimit', {
  id: uuid().defaultRandom().primaryKey().notNull(),
  key: text().notNull().unique(),
  count: integer().notNull(),
  lastRequest: bigint({ mode: 'number' }).notNull(),
});

export const replicaKeys = pgTable(
  'replica_keys',
  {
    userId: uuid('user_id').notNull(),
    saltId: text('salt_id').notNull(),
    alg: text().notNull(),
    // TODO: failed to parse database type 'bytea'
    salt: bytea('salt').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'replica_keys_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.saltId], name: 'replica_keys_pkey' }),
    pgPolicy('replica_keys_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('replica_keys_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('replica_keys_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const statBooks = pgTable(
  'stat_books',
  {
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    title: text().default('').notNull(),
    authors: text().default('').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_stat_books_user_updated').using(
      'btree',
      table.userId.asc().nullsLast().op('timestamptz_ops'),
      table.updatedAt.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'stat_books_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.bookHash], name: 'stat_books_pkey' }),
    pgPolicy('stat_books_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('stat_books_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('stat_books_update', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('stat_books_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const usageStats = pgTable(
  'usage_stats',
  {
    userId: uuid('user_id').notNull(),
    usageType: text('usage_type').notNull(),
    usageDate: date('usage_date').notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    usageCount: bigint('usage_count', { mode: 'number' }).default(0).notNull(),
    metadata: jsonb().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'usage_stats_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.usageType, table.usageDate],
      name: 'usage_stats_pkey',
    }),
  ],
);

export const statPages = pgTable(
  'stat_pages',
  {
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    page: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    startTime: bigint('start_time', { mode: 'number' }).notNull(),
    duration: integer().default(0).notNull(),
    totalPages: integer('total_pages').default(0).notNull(),
    ext: jsonb(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('idx_stat_pages_user_updated').using(
      'btree',
      table.userId.asc().nullsLast().op('timestamptz_ops'),
      table.updatedAt.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'stat_pages_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.bookHash, table.page, table.startTime],
      name: 'stat_pages_pkey',
    }),
    pgPolicy('stat_pages_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('stat_pages_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('stat_pages_update', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('stat_pages_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const replicas = pgTable(
  'replicas',
  {
    userId: uuid('user_id').notNull(),
    kind: text().notNull(),
    replicaId: text('replica_id').notNull(),
    fieldsJsonb: jsonb('fields_jsonb').default({}).notNull(),
    manifestJsonb: jsonb('manifest_jsonb'),
    deletedAtTs: text('deleted_at_ts'),
    reincarnation: text(),
    updatedAtTs: text('updated_at_ts').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    modifiedAt: timestamp('modified_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('idx_replicas_pull_cursor').using(
      'btree',
      table.userId.asc().nullsLast().op('uuid_ops'),
      table.kind.asc().nullsLast().op('text_ops'),
      table.updatedAtTs.asc().nullsLast().op('uuid_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'replicas_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.kind, table.replicaId], name: 'replicas_pkey' }),
    pgPolicy('replicas_select', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('replicas_insert', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('replicas_update', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('replicas_delete', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
    check('replicas_fields_size', sql`pg_column_size(fields_jsonb) <= 65536`),
    check('replicas_schema_version', sql`(schema_version >= 1) AND (schema_version <= 1000)`),
    check(
      'replicas_kind_allowlist',
      sql`kind = ANY (ARRAY['dictionary'::text, 'font'::text, 'texture'::text, 'opds_catalog'::text, 'settings'::text])`,
    ),
  ],
);

export const bookConfigs = pgTable(
  'book_configs',
  {
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    location: text(),
    xpointer: text(),
    progress: jsonb(),
    rsvpPosition: text('rsvp_position'),
    searchConfig: jsonb('search_config'),
    viewSettings: jsonb('view_settings'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'book_configs_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.bookHash], name: 'book_configs_pkey' }),
    pgPolicy('select_book_configs', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('insert_book_configs', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('update_book_configs', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('delete_book_configs', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const bookNotes = pgTable(
  'book_notes',
  {
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    id: text().notNull(),
    type: text(),
    cfi: text(),
    xpointer0: text(),
    xpointer1: text(),
    text: text(),
    style: text(),
    color: text(),
    note: text(),
    page: integer(),
    global: boolean(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'book_notes_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.bookHash, table.id], name: 'book_notes_pkey' }),
    pgPolicy('select_book_notes', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('insert_book_notes', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('update_book_notes', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('delete_book_notes', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);

export const books = pgTable(
  'books',
  {
    userId: uuid('user_id').notNull(),
    bookHash: text('book_hash').notNull(),
    metaHash: text('meta_hash'),
    format: text(),
    title: text(),
    sourceTitle: text('source_title'),
    author: text(),
    group: text(),
    tags: text().array(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true, mode: 'string' }),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true, mode: 'string' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
    progress: integer().array(),
    readingStatus: text('reading_status'),
    readingStatusUpdatedAt: timestamp('reading_status_updated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    coverHash: text('cover_hash'),
    coverUpdatedAt: timestamp('cover_updated_at', { withTimezone: true, mode: 'string' }),
    metadataUpdatedAt: timestamp('metadata_updated_at', { withTimezone: true, mode: 'string' }),
    groupId: text('group_id'),
    groupName: text('group_name'),
    metadata: json(),
  },
  (table) => [
    index('idx_books_user_synced').using(
      'btree',
      table.userId.asc().nullsLast().op('timestamptz_ops'),
      table.syncedAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'books_user_id_fkey',
    }).onDelete('cascade'),
    primaryKey({ columns: [table.userId, table.bookHash], name: 'books_pkey' }),
    pgPolicy('select_books', {
      as: 'permissive',
      for: 'select',
      to: ['authenticated'],
      using: sql`(( SELECT auth.uid() AS uid) = user_id)`,
    }),
    pgPolicy('insert_books', { as: 'permissive', for: 'insert', to: ['authenticated'] }),
    pgPolicy('update_books', { as: 'permissive', for: 'update', to: ['authenticated'] }),
    pgPolicy('delete_books', { as: 'permissive', for: 'delete', to: ['authenticated'] }),
  ],
);
