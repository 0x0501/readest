-- Ours, not upstream. Better Auth's passkey table (ADR-018).
--
-- Generated, never hand-written — the recipe is in `drizzle/README.md`, run with
-- `@better-auth/passkey` added to the plugin list. The adapter matches columns by
-- name, so DDL that drifts from what the plugin compiled fails at runtime rather
-- than at build time (ADR-009).
--
-- `id` is uuid for the same reason as every other Better Auth table here:
-- `advanced.database.generateId` is set to 'uuid' (see local_001).
--
-- `credentialID` is the authenticator's own identifier and is what a sign-in
-- looks a row up by — no email is sent, so the index is what makes passkey
-- sign-in a single lookup rather than a scan.

create table "passkey" (
  "id" uuid default pg_catalog.gen_random_uuid() not null primary key,
  "name" text,
  "publicKey" text not null,
  "userId" uuid not null references "user" ("id") on delete cascade,
  "credentialID" text not null,
  "counter" integer not null,
  "deviceType" text not null,
  "backedUp" boolean not null,
  "transports" text,
  "createdAt" timestamptz,
  "aaguid" text
);

create index "passkey_userId_idx" on "passkey" ("userId");

create index "passkey_credentialID_idx" on "passkey" ("credentialID");
