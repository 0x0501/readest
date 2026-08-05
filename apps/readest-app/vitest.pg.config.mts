import tsconfigPaths from 'vite-tsconfig-paths';
import { defineConfig } from 'vitest/config';

// Tests that need a real Postgres (ADR-012). The unit lane excludes
// `*.pg.test.ts` outright, so this is the only config that runs them; point
// DATABASE_URL at a database the migration chain has been applied to.
//
// No jsdom, no setup file: these exercise server code against the database and
// nothing else.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    environment: 'node',
    include: ['src/**/*.pg.test.ts'],
    // The rows are keyed by one throwaway user per file, but they share a
    // database — running the files in sequence keeps a failure readable.
    fileParallelism: false,
  },
});
