-- Ours, not upstream. Better Auth's own tables.
--
-- Generated, never hand-written. Better Auth compiles the DDL for whatever plugin
-- set it is configured with; after upgrading `better-auth`, re-run the recipe in
-- `drizzle/README.md` and append whatever it adds as a new `local_*.sql`
-- (ADR-009). Missing that step surfaces at runtime, not at compile time.
--
-- Primary keys are `uuid` because `advanced.database.generateId` is set to
-- 'uuid'. Better Auth's default is a random `text` id, which would not fit the
-- twelve `user_id uuid` foreign keys that local_002 re-points at `public."user"`,
-- nor the `${user.id}/${fileName}` object-storage key layout.
--
-- `user` is a reserved word in Postgres; every reference must be quoted.

create table "user" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" boolean not null,
  "image" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create table "session" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "expiresAt" timestamptz not null,
  "token" text not null unique,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" uuid not null references "user" ("id") on delete cascade
);

create table "account" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" uuid not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz not null
);

create table "verification" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" timestamptz not null,
  "createdAt" timestamptz default CURRENT_TIMESTAMP not null,
  "updatedAt" timestamptz default CURRENT_TIMESTAMP not null
);

create table "jwks" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "publicKey" text not null,
  "privateKey" text not null,
  "createdAt" timestamptz not null,
  "expiresAt" timestamptz
);

create table "apikey" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "configId" text not null,
  "name" text,
  "start" text,
  "referenceId" text not null,
  "prefix" text,
  "key" text not null,
  "refillInterval" integer,
  "refillAmount" integer,
  "lastRefillAt" timestamptz,
  "enabled" boolean,
  "rateLimitEnabled" boolean,
  "rateLimitTimeWindow" integer,
  "rateLimitMax" integer,
  "requestCount" integer,
  "remaining" integer,
  "lastRequest" timestamptz,
  "expiresAt" timestamptz,
  "createdAt" timestamptz not null,
  "updatedAt" timestamptz not null,
  "permissions" text,
  "metadata" text
);

create index "session_userId_idx" on "session" (
  "userId"
);

create index "account_userId_idx" on "account" (
  "userId"
);

create index "verification_identifier_idx" on "verification" (
  "identifier"
);

create index "apikey_configId_idx" on "apikey" (
  "configId"
);

create index "apikey_referenceId_idx" on "apikey" (
  "referenceId"
);

create index "apikey_key_idx" on "apikey" (
  "key"
);
