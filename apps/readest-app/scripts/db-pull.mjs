// Regenerate `src/libs/db/schema.ts` by reflecting the live database.
//
// Upstream's SQL is the source of truth for the schema (docs/database.md,
// ADR-003), so the Drizzle
// schema is a generated artifact used only for types and query building — never
// hand-edited, and never the thing a migration is diffed against.
//
// `drizzle-kit pull` insists on writing schema.ts, relations.ts, a snapshot and a
// baseline .sql into its `out` directory, and rewrites `meta/_journal.json` while
// doing so. That journal is hand-maintained (it is what skips upstream's
// migration 016), so pull runs against a throwaway directory and only schema.ts
// is kept.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env['DATABASE_URL']) {
  console.error('DATABASE_URL is required.');
  process.exit(1);
}

// Resolved rather than taken from PATH so the script behaves the same whether it
// is run through `pnpm db:pull` or directly with node.
const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const drizzleKit = join(app, 'node_modules/.bin/drizzle-kit');
const biome = join(app, '../../node_modules/.bin/biome');
const schemaPath = join(app, 'src/libs/db/schema.ts');

const scratch = mkdtempSync(join(tmpdir(), 'readest-db-pull-'));
try {
  const config = join(scratch, 'drizzle.config.mjs');
  writeFileSync(
    config,
    `export default ${JSON.stringify({
      dialect: 'postgresql',
      out: scratch,
      dbCredentials: { url: process.env['DATABASE_URL'] },
      schemaFilter: ['public'],
    })};\n`,
  );
  execFileSync(drizzleKit, ['pull', `--config=${config}`], { stdio: 'inherit' });

  // Two things drizzle-kit 0.31.10 gets wrong on this database, both repaired
  // here rather than in the output because the output is regenerated on every
  // upstream migration.
  let schema = readFileSync(join(scratch, 'schema.ts'), 'utf8');

  // 1. A column whose default is the empty string comes out as `.default(')`,
  //    which does not parse. Upstream's migration 014 gives stat_books.title and
  //    .authors such a default. `.default(')` is never valid, so this is
  //    unambiguous.
  schema = schema.replaceAll(".default(')", ".default('')");

  // 2. `bytea` has no builtin in drizzle-orm, and introspection emits a call to
  //    an undeclared `unknown()` for it — which bundles fine and then throws
  //    `unknown is not defined` at Worker startup. Upstream's migration 008 gives
  //    replica_keys.salt that type. Declare the customType drizzle documents for
  //    binary columns and point the call at it.
  if (schema.includes('unknown(')) {
    schema = schema
      .replace('} from "drizzle-orm/pg-core"', ', customType } from "drizzle-orm/pg-core"')
      .replaceAll('unknown(', 'bytea(')
      .replace(
        'import { sql } from "drizzle-orm"',
        'import { sql } from "drizzle-orm"\n\n' +
          'const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });',
      );
  }

  // 3. drizzle-kit camel-cases a column name into the property key and lets the
  //    key stand in for the column, so `"credentialID"` comes back as
  //    `credentialId: text()` — which addresses a column that does not exist.
  //    Renaming the key is the whole fix: drizzle derives the column from it.
  //
  //    This one is worth more care than the other two because it fails silently
  //    in both directions. Better Auth's Drizzle adapter looks a column up as
  //    `schemaModel[fieldName]` and does `if (!schemaModel[field]) continue` —
  //    so a key it cannot find drops that condition from the WHERE clause rather
  //    than raising, and a passkey lookup by credential returns whatever row
  //    came first.
  schema = schema.replaceAll('credentialId', 'credentialID');

  // Both repairs are workarounds for bugs in drizzle-kit's introspection, keyed
  // to the exact strings it emits. `drizzle-kit` is on a caret range, so a
  // version that changes those strings would leave the output broken —
  // `.default(')` would fail to parse and `unknown()` would throw at Worker
  // startup, both a long way from here. Fail now instead.
  for (const leftover of ["unknown(", ".default(')"]) {
    if (schema.includes(leftover)) {
      throw new Error(
        `drizzle-kit still emits ${leftover} after the repairs in this script. ` +
          'Its output has changed; re-check the workarounds against the current version.',
      );
    }
  }

  // Repair 3 is one instance of a general hazard: any column whose name does not
  // survive drizzle-kit's camel-casing addresses a column that is not there.
  // Rather than wait to be surprised by the next one, check every column the
  // pull actually saw. The baseline SQL drizzle-kit writes alongside schema.ts
  // quotes real column names, so it is the authority on what the database has.
  // drizzle-kit names the baseline with a random suffix, so find it by extension.
  const baselineFile = readdirSync(scratch).find((name) => name.endsWith('.sql'));
  const baseline = readFileSync(join(scratch, baselineFile), 'utf8');
  const columns = new Set(
    [...baseline.matchAll(/^\s+"([A-Za-z_][A-Za-z0-9_]*)"\s/gm)].map((match) => match[1]),
  );
  const missing = [...columns]
    .filter((column) => !new RegExp(`\\b${column}\\b`).test(schema))
    .sort();
  if (missing.length) {
    throw new Error(
      `These columns exist in the database but no identifier in the generated schema ` +
        `matches them, so any query against them silently addresses nothing: ${missing.join(', ')}. ` +
        'Add a repair above, as with credentialID.',
    );
  }

  writeFileSync(schemaPath, schema);
  // drizzle-kit's output does not match the repo's Biome style, and `src/` is not
  // exempt from `pnpm format:check`.
  execFileSync(biome, ['format', '--write', schemaPath], { stdio: 'inherit' });
  console.log('wrote src/libs/db/schema.ts');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
