/*
# Store HTML files in cloud storage

1. New Tables
- `runner_files` — one row per uploaded HTML file (metadata only; the file bytes live in Storage):
  - `path` (text, primary key): full path as chosen by the user (e.g. "minecraft/index.html").
  - `name` (text): file name for display in the sidebar.
  - `size` (bigint): file size in bytes, used to skip re-upload when unchanged.
  - `mime_type` (text): file content type, defaults to "text/html".
  - `updated_at` (timestamptz): when the file was last saved.
2. Storage
- Public bucket `runner-files` holds the actual file bytes (up to 100 MB+ files).
3. Security
- Enable RLS on `runner_files`.
- This is a single-tenant app with no sign-in: grant SELECT, INSERT, UPDATE, DELETE
  to `anon` and `authenticated`, with permissive policies (`TO anon, authenticated`).
  The data is intentionally shared/personal-local; no user accounts exist.
- Storage policies allow public read and anon-authenticated write on the bucket.
*/

CREATE TABLE IF NOT EXISTS runner_files (
  path text PRIMARY KEY,
  name text NOT NULL,
  size bigint NOT NULL DEFAULT 0,
  mime_type text NOT NULL DEFAULT 'text/html',
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE runner_files ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON runner_files TO anon, authenticated;

DROP POLICY IF EXISTS "anon_select_runner_files" ON runner_files;
CREATE POLICY "anon_select_runner_files" ON runner_files
FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "anon_insert_runner_files" ON runner_files;
CREATE POLICY "anon_insert_runner_files" ON runner_files
FOR INSERT TO anon, authenticated WITH CHECK (true);

DROP POLICY IF EXISTS "anon_update_runner_files" ON runner_files;
CREATE POLICY "anon_update_runner_files" ON runner_files
FOR UPDATE TO anon, authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "anon_delete_runner_files" ON runner_files;
CREATE POLICY "anon_delete_runner_files" ON runner_files
FOR DELETE TO anon, authenticated USING (true);
