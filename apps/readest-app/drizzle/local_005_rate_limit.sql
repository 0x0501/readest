-- Ours, not upstream. Better Auth's rateLimit table (ADR-020).
--
-- Generated shape, never hand-written beyond the uuid primary key that every
-- Better Auth table here carries — `advanced.database.generateId` is set to
-- 'uuid' (see local_001). The adapter matches columns by name, so DDL that
-- drifts from what Better Auth compiled fails at runtime rather than at
-- build time (ADR-009).
--
-- `key` is the rate-limit bucket identifier (typically IP + path). `count` is
-- the number of requests in the current window; `lastRequest` is epoch ms.
-- Without this table, Better Auth falls back to in-memory storage, which is
-- useless across Worker isolates.

create table "rateLimit" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);
