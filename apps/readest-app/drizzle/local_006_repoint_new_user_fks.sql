-- Upstream 020 adds stat_archives.user_id against the unused auth.users stub.
-- Re-point every newly introduced auth.users FK on public tables after adopting
-- upstream SQL. GoTrue tables in the auth schema stay on auth.users: they are
-- owned by supabase_auth_admin, and the connecting role cannot ALTER them.
DO $$
DECLARE fk record;
BEGIN
  FOR fk IN
    SELECT c.conname, c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.confrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace rn ON rn.oid = rel.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
    WHERE c.contype = 'f' AND n.nspname = 'auth' AND t.relname = 'users'
      AND rn.nspname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.tbl, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public."user"(id) ON DELETE CASCADE',
      fk.tbl, fk.conname, fk.col
    );
  END LOOP;
END $$;
