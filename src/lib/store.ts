import type { FileEntry } from './loader';

const DB_NAME = 'html-runner-db';
const DB_VERSION = 1;
const STORE = 'files';

interface StoredFile {
  path: string;
  name: string;
  size: number;
  type: string;
  blob: Blob;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'path' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open local database'));
  });
}

function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const req = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(req.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('Local database error'));
        };
      })
  );
}

export async function saveFiles(entries: FileEntry[]): Promise<void> {
  if (!entries.length) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      for (const e of entries) {
        const record: StoredFile = {
          path: e.path,
          name: e.file.name,
          size: e.file.size,
          type: e.file.type || 'text/html',
          blob: e.file,
          savedAt: Date.now(),
        };
        store.put(record);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Failed to save files'));
    });
  } finally {
    db.close();
  }
}

export async function loadSavedFiles(): Promise<FileEntry[]> {
  const records = await withStore<StoredFile[]>('readonly', (s) => s.getAll());
  return records.map((r) => {
    const file =
      r.blob instanceof File
        ? r.blob
        : new File([r.blob], r.name, { type: r.type });
    return { path: r.path, file };
  });
}

export async function deleteSavedFile(path: string): Promise<void> {
  await withStore('readwrite', (s) => s.delete(path));
}

export async function clearSavedFiles(): Promise<void> {
  await withStore('readwrite', (s) => s.clear());
}
