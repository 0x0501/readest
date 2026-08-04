// Regenerate `src/libs/db/schema.ts` by reflecting the live database.
//
// Upstream's SQL is the source of truth for the schema (ADR-003), so the Drizzle
// schema is a generated artifact used only for types and query building — never
// hand-edited, and never the thing a migration is diffed against.
//
// `drizzle-kit pull` insists on writing schema.ts, relations.ts, a snapshot and a
// baseline .sql into its `out` directory, and rewrites `meta/_journal.json` while
// doing so. That journal is hand-maintained (it is what skips upstream's
// migration 016), so pull runs against a throwaway directory and only schema.ts
// is kept.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  writeFileSync(schemaPath, schema);
  // drizzle-kit's output does not match the repo's Biome style, and `src/` is not
  // exempt from `pnpm format:check`.
  execFileSync(biome, ['format', '--write', schemaPath], { stdio: 'inherit' });
  console.log('wrote src/libs/db/schema.ts');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
