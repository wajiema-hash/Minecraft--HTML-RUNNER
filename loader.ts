export interface FileEntry {
  path: string;
  file: File;
}

export const HTML_RE = /\.html?$/i;

export function toEntry(file: File): FileEntry {
  return { path: file.webkitRelativePath || file.name, file };
}

async function readDir(dir: FileSystemDirectoryEntry, out: FileEntry[]): Promise<void> {
  const reader = dir.createReader();
  const readBatch = (): Promise<FileSystemEntry[]> =>
    new Promise((resolve, reject) => reader.readEntries(resolve, reject));

  let batch = await readBatch();
  while (batch.length) {
    for (const entry of batch) {
      if (entry.isFile) {
        const file = await new Promise<File>((resolve, reject) =>
          (entry as FileSystemFileEntry).file(resolve, reject)
        );
        out.push(toEntry(file));
      } else if (entry.isDirectory) {
        await readDir(entry as FileSystemDirectoryEntry, out);
      }
    }
    batch = await readBatch();
  }
}

export async function entriesFromDataTransfer(dt: DataTransfer): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  const items = Array.from(dt.items ?? []);
  const fsEntries = items
    .map((item) => (typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null))
    .filter((e): e is FileSystemEntry => e !== null);

  for (const entry of fsEntries) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) =>
        (entry as FileSystemFileEntry).file(resolve, reject)
      );
      out.push(toEntry(file));
    } else if (entry.isDirectory) {
      await readDir(entry as FileSystemDirectoryEntry, out);
    }
  }

  if (out.length) return out;
  return Array.from(dt.files).map(toEntry);
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    const aHtml = HTML_RE.test(a.path) ? 0 : 1;
    const bHtml = HTML_RE.test(b.path) ? 0 : 1;
    return aHtml - bHtml || a.path.localeCompare(b.path);
  });
}
