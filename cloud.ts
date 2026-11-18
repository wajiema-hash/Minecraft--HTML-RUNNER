import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL as string,
  import.meta.env.VITE_SUPABASE_ANON_KEY as string
);

const BUCKET = 'runner-files';

export interface CloudFile {
  path: string;
  name: string;
  size: number;
  mime_type: string;
  updated_at: string;
}

export async function listCloudFiles(): Promise<CloudFile[]> {
  const { data, error } = await supabase
    .from('runner_files')
    .select('path, name, size, mime_type, updated_at')
    .order('path');
  if (error) throw error;
  return data ?? [];
}

export async function downloadCloudFile(path: string): Promise<File> {
  const { data, error } = await supabase.storage.from(BUCKET).download(path);
  if (error) throw error;
  const name = path.split('/').pop() || path;
  return new File([data], name, { type: data.type || 'text/html' });
}

export async function uploadCloudFile(
  path: string,
  file: File,
  onProgress?: (pct: number) => void
): Promise<void> {
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type || 'text/html' });
  if (upErr) throw upErr;
  onProgress?.(90);

  const { error: dbErr } = await supabase.from('runner_files').upsert({
    path,
    name: file.name,
    size: file.size,
    mime_type: file.type || 'text/html',
    updated_at: new Date().toISOString(),
  });
  if (dbErr) throw dbErr;
  onProgress?.(100);
}

export async function deleteCloudFile(path: string): Promise<void> {
  const { error: storeErr } = await supabase.storage.from(BUCKET).remove([path]);
  if (storeErr) throw storeErr;
  const { error: dbErr } = await supabase.from('runner_files').delete().eq('path', path);
  if (dbErr) throw dbErr;
}

export async function clearCloudFiles(paths: string[]): Promise<void> {
  if (!paths.length) return;
  await Promise.all(paths.map((p) => deleteCloudFile(p)));
}

export function isStorageQuotaError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return (
    msg.includes('payload too large') ||
    msg.includes('exceeded') ||
    msg.includes('quota') ||
    msg.includes('413')
  );
}
