-- Ours, not upstream. Moves the user foreign keys onto Better Auth's table.
--
-- Upstream declares twelve `user_id uuid REFERENCES auth.users(id) ON DELETE
-- CASCADE` across 000/002/003/012/014. `auth.users` is a stub from local_000 that
-- never holds a row; the real users live in `public."user"` (ADR-007).
--
-- Done as a loop rather than twelve hand-written statements so it cannot miss one
-- by transcription. The stub table stays in place afterwards: a future upstream
-- migration adding another `REFERENCES auth.users(id)` still applies, and
-- re-pointing it is a copy of this file.

DO $$
DECLARE
  fk record;
BEGIN
  FOR fk IN
    SELECT c.conname,
           c.conrelid::regclass AS tbl,
           a.attname AS col
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND n.nspname = 'auth' AND t.relname = 'users'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public."user"(id) ON DELETE CASCADE',
      fk.tbl, fk.conname, fk.col);
  END LOOP;

  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.contype = 'f' AND n.nspname = 'auth' AND t.relname = 'users'
  ) THEN
    RAISE EXCEPTION 'foreign keys still reference auth.users';
  END IF;
END $$;
