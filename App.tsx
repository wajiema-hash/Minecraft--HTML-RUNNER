import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  FileCode2,
  FolderOpen,
  Globe2,
  ExternalLink,
  HardDrive,
  Maximize2,
  Minimize2,
  Moon,
  RefreshCw,
  Sun,
  Upload,
  X,
} from 'lucide-react';
import { buildDocument } from './lib/runner';
import {
  HTML_RE,
  entriesFromDataTransfer,
  sortEntries,
  toEntry,
  type FileEntry,
} from './lib/loader';
import {
  clearSavedFiles,
  deleteSavedFile,
  loadSavedFiles,
  saveFiles,
} from './lib/store';
import {
  clearCloudFiles,
  deleteCloudFile,
  downloadCloudFile,
  isStorageQuotaError,
  listCloudFiles,
  uploadCloudFile,
} from './lib/cloud';

const PREVIEW_EXTENSION = '.runner-preview.html';
const LARGE_FILE_BYTES = 2 * 1024 * 1024;

export default function App() {
  const [dark, setDark] = useState(true);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [docSrc, setDocSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [mobilePanel, setMobilePanel] = useState<'files' | 'preview'>('preview');
  const [maximized, setMaximized] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [syncing, setSyncing] = useState<string[]>([]);
  const [unstable, setUnstable] = useState(false);

  const frameRef = useRef<HTMLDivElement>(null);
  const urlRef = useRef<string | null>(null);
  const lastBuild = useRef<{ path: string; nonce: number }>({ path: '', nonce: -1 });
  const cancelledUploads = useRef(false);
  const frameLoads = useRef<number[]>([]);

  useEffect(() => {
    cancelledUploads.current = false;
    return () => {
      cancelledUploads.current = true;
    };
  }, []);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [local, cloud] = await Promise.all([
          loadSavedFiles(),
          listCloudFiles().catch(() => []),
        ]);
        if (cancelled) return;
        const localByPath = new Map(local.map((e) => [e.path, e]));
        const merged: FileEntry[] = [...local];
        const missingFromLocal = cloud.filter((c) => !localByPath.has(c.path));
        if (missingFromLocal.length) {
          setSyncing(missingFromLocal.map((c) => c.path));
          const downloaded = await Promise.all(
            missingFromLocal.map(async (c) => {
              try {
                const file = await downloadCloudFile(c.path);
                return { path: c.path, file } as FileEntry;
              } catch {
                return null;
              }
            })
          );
          if (cancelled) return;
          const ok = downloaded.filter((e): e is FileEntry => e !== null);
          merged.push(...ok);
          void saveFiles(ok).catch(() => undefined);
        }
        if (merged.length) {
          setEntries(sortEntries(merged));
          // Restored files stay unrun: the preview starts empty until you
          // pick a page from the sidebar.
        }
      } catch {
        // restore failed; start empty
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const activeEntry = useMemo(
    () => entries.find((e) => e.path === activePath) ?? null,
    [entries, activePath]
  );

  const render = useCallback(
    async (entry: FileEntry, all: FileEntry[], bump: number) => {
      if (
        lastBuild.current.path === entry.path &&
        lastBuild.current.nonce === bump &&
        docSrc
      ) {
        return;
      }
      setBuilding(true);
      setError(null);
      try {
        // Large self-contained files skip processing: the browser streams
        // straight from disk without the file ever being read into memory.
        const isLarge = entry.file.size > LARGE_FILE_BYTES;
        const html = isLarge ? null : await buildDocument(all, entry.path);
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(
          html !== null
            ? new Blob([html], { type: 'text/html' })
            : entry.file
        );
        urlRef.current = url;
        setDocSrc(url);
        lastBuild.current = { path: entry.path, nonce: bump };
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load file');
        setDocSrc(null);
        lastBuild.current = { path: '', nonce: -1 };
      } finally {
        setBuilding(false);
      }
    },
    [docSrc]
  );

  const addFiles = useCallback(
    (list: File[]) => {
      const incoming = sortEntries(Array.from(list).map(toEntry));
      if (!incoming.length) return;
      setEntries((prev) => {
        const byPath = new Map(prev.map((e) => [e.path, e]));
        for (const e of incoming) byPath.set(e.path, e);
        return sortEntries(Array.from(byPath.values()));
      });
      const firstHtml = incoming.find((e) => HTML_RE.test(e.path));
      if (firstHtml) {
        setActivePath(firstHtml.path);
        setMobilePanel('preview');
      }
      void saveFiles(incoming).catch(() => undefined);
      setSyncing(incoming.map((e) => e.path));
      (async () => {
        for (const entry of incoming) {
          try {
            await uploadCloudFile(entry.path, entry.file);
          } catch (err) {
            if (!cancelledUploads.current) {
              setError(
                isStorageQuotaError(err)
                  ? `Could not save "${entry.file.name}" to cloud storage (file too large or storage full). It still runs from your device.`
                  : `Could not save "${entry.file.name}" to cloud storage. It still runs from your device.`
              );
            }
          } finally {
            if (!cancelledUploads.current) {
              setSyncing((prev) => prev.filter((p) => p !== entry.path));
            }
          }
        }
      })();
    },
    []
  );

  useEffect(() => {
    if (!activeEntry || !entries.length) return;
    void render(activeEntry, entries, nonce);
  }, [activeEntry, entries, nonce, render]);

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.html,.htm,text/html';
    input.onchange = () => {
      if (input.files) addFiles(Array.from(input.files));
    };
    input.click();
  };

  const pickFolder = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.webkitdirectory = true;
    input.onchange = () => {
      if (input.files) addFiles(Array.from(input.files));
    };
    input.click();
  };

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const found = await entriesFromDataTransfer(e.dataTransfer);
    addFiles(found.map((entry) => entry.file));
  };

  const toggleFullscreen = () => {
    const frameArea = frameRef.current;
    if (!frameArea) return;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void frameArea.requestFullscreen();
    }
  };

  const openInTab = () => {
    if (!docSrc || !activeEntry) return;
    const name = activeEntry.file.name.replace(/\.html?$/i, '') || 'page';
    const link = document.createElement('a');
    link.href = docSrc;
    link.download = `${name}${PREVIEW_EXTENSION}`;
    link.click();
  };

  const openStandalone = () => {
    if (!docSrc) return;
    setUnstable(false);
    window.open(docSrc, '_blank', 'noopener');
  };

  const onFrameLoad = () => {
    const now = Date.now();
    frameLoads.current = [...frameLoads.current, now].filter((t) => now - t < 60_000);
    if (frameLoads.current.length >= 4) setUnstable(true);
  };

  // A user-driven reload or file switch resets the reload watchdog.
  useEffect(() => {
    frameLoads.current = [];
    setUnstable(false);
  }, [activePath, nonce]);

  const shell = dark ? 'bg-slate-950 text-slate-200' : 'bg-slate-100 text-slate-800';
  const panel = dark
    ? 'bg-slate-900 border-slate-800'
    : 'bg-white border-slate-200';
  const subtle = dark ? 'text-slate-400' : 'text-slate-500';

  const htmlFiles = entries.filter((e) => HTML_RE.test(e.path));
  const assetCount = entries.length - htmlFiles.length;

  return (
    <div
      className={`min-h-screen flex flex-col transition-colors duration-300 ${shell}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={onDrop}
    >
      <header
        className={`flex items-center gap-3 px-4 h-14 border-b shrink-0 ${panel} ${
          maximized ? 'hidden md:hidden' : ''
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-emerald-500/15 text-emerald-500 flex items-center justify-center shrink-0">
            <Globe2 className="w-4.5 h-4.5" size={18} />
          </div>
          <span className="font-semibold tracking-tight truncate">
            HTML Runner
          </span>
        </div>

        <div className="flex-1" />

        {activeEntry && (
          <button
            onClick={() => setNonce((n) => n + 1)}
            title="Reload preview"
            className={`p-2 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${subtle}`}
          >
            <RefreshCw
              size={16}
              className={building ? 'animate-spin' : undefined}
            />
          </button>
        )}
        <button
          onClick={() => setDark((d) => !d)}
          title="Toggle theme"
          className={`p-2 rounded-lg hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${subtle}`}
        >
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <div className="flex-1 flex min-h-0 relative">
        {/* Sidebar */}
        <aside
          className={`${
            mobilePanel === 'files' ? 'flex' : 'hidden'
          } ${
            maximized ? 'md:hidden' : 'md:flex'
          } w-full md:w-72 shrink-0 flex-col border-r ${panel} absolute md:relative inset-0 md:inset-auto z-10`}
        >
          <div className="p-3 space-y-2">
            <button
              onClick={pickFiles}
              className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
            >
              <Upload size={15} />
              Open HTML files
            </button>
            <button
              onClick={pickFolder}
              className={`w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                dark
                  ? 'border-slate-700 hover:bg-slate-800'
                  : 'border-slate-300 hover:bg-slate-50'
              }`}
            >
              <FolderOpen size={15} />
              Open folder
            </button>
          </div>

          <div className={`px-4 pb-1 text-xs font-medium uppercase tracking-wider ${subtle}`}>
            {htmlFiles.length
              ? `${htmlFiles.length} page${htmlFiles.length === 1 ? '' : 's'}${
                  assetCount ? ` · ${assetCount} assets` : ''
                }`
              : 'No files yet'}
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-3">
            {htmlFiles.map((e) => {
              const isActive = e.path === activePath;
              const dir = e.path.includes('/')
                ? e.path.slice(0, e.path.lastIndexOf('/'))
                : '';
              return (
                <div
                  key={e.path}
                  className={`group flex items-center rounded-lg mb-0.5 transition-colors ${
                    isActive
                      ? dark
                        ? 'bg-emerald-500/15 text-emerald-300'
                        : 'bg-emerald-50 text-emerald-700'
                      : `hover:bg-black/5 ${dark ? 'hover:bg-slate-800' : ''}`
                  }`}
                >
                  <button
                    onClick={() => {
                      setActivePath(e.path);
                      setMobilePanel('preview');
                    }}
                    className="flex-1 min-w-0 text-left px-3 py-2 flex items-center gap-2.5"
                  >
                    <FileCode2 size={15} className="shrink-0 opacity-60" />
                    <span className="min-w-0">
                      <span className="block text-sm truncate">
                        {e.file.name}
                      </span>
                      {dir && (
                        <span className={`block text-xs truncate ${subtle}`}>
                          {dir}
                        </span>
                      )}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setEntries((prev) => {
                        const next = prev.filter((x) => x.path !== e.path);
                        if (activePath === e.path) {
                          setActivePath(
                            next.find((x) => HTML_RE.test(x.path))?.path ?? null
                          );
                        }
                        return next;
                      });
                      void deleteSavedFile(e.path);
                      void deleteCloudFile(e.path).catch(() => undefined);
                    }}
                    title="Remove"
                    className={`p-2 mr-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity ${subtle}`}
                  >
                    <X size={14} />
                  </button>
                </div>
              );
            })}
            {!htmlFiles.length && (
              <p className={`px-3 py-6 text-sm text-center ${subtle}`}>
                Drop HTML files or a folder anywhere on this window.
              </p>
            )}
          </div>

          <div className={`p-3 border-t text-xs space-y-2 ${panel} ${subtle}`}>
            <div className="flex items-start gap-2">
              <HardDrive size={14} className="shrink-0 mt-0.5" />
              <span>
                Files are saved in this app and reload automatically next time.
              </span>
            </div>
            {htmlFiles.length > 0 && (
              <button
                onClick={() => {
                  const paths = entries.map((x) => x.path);
                  setEntries([]);
                  setActivePath(null);
                  void clearSavedFiles();
                  void clearCloudFiles(paths).catch(() => undefined);
                }}
                className="text-red-500 hover:text-red-400 transition-colors"
              >
                Clear saved files
              </button>
            )}
            {syncing.length > 0 && (
              <div className="flex items-center gap-2 text-emerald-500">
                <RefreshCw size={12} className="animate-spin" />
                <span>
                  Saving {syncing.length === 1 ? syncing[0].split('/').pop() : `${syncing.length} files`} to cloud…
                </span>
              </div>
            )}
          </div>
        </aside>

        {/* Preview */}
        <main
          className={`flex-1 min-w-0 flex flex-col ${
            mobilePanel === 'preview' ? 'flex' : 'hidden md:flex'
          }`}
        >
          {activeEntry ? (
            <>
              <div
                className={`h-10 shrink-0 flex items-center gap-2 px-3 border-b text-xs ${panel} ${subtle}`}
              >
                <button
                  onClick={() => setMobilePanel('files')}
                  className="md:hidden p-1 -ml-1 rounded hover:bg-black/10"
                  title="Back to files"
                >
                  <FileCode2 size={14} />
                </button>
                <span className="truncate font-medium">{activeEntry.path}</span>
                {activeEntry.file.size > LARGE_FILE_BYTES && (
                  <span
                    className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                      dark
                        ? 'bg-amber-500/15 text-amber-400'
                        : 'bg-amber-100 text-amber-700'
                    }`}
                  >
                    Large file
                  </span>
                )}
                <span className="flex-1" />
                <button
                  onClick={() => setMaximized((m) => !m)}
                  title={maximized ? 'Show sidebar' : 'Fill window'}
                  className={`p-1.5 rounded-md transition-colors ${
                    dark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                  }`}
                >
                  {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                </button>
                <button
                  onClick={toggleFullscreen}
                  title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                  className={`p-1.5 rounded-md transition-colors ${
                    dark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                  }`}
                >
                  {isFullscreen ? (
                    <Minimize2 size={14} />
                  ) : (
                    <Maximize2 size={14} />
                  )}
                </button>
                <button
                  onClick={openStandalone}
                  title="Open in its own browser tab (most reliable for games)"
                  className={`flex items-center gap-1.5 px-2 py-1 rounded-md transition-colors ${
                    dark ? 'hover:bg-slate-800' : 'hover:bg-slate-100'
                  }`}
                >
                  <ExternalLink size={14} />
                  New tab
                </button>
                <button
                  onClick={openInTab}
                  className={`px-2 py-1 rounded-md hover:bg-black/10 dark:hover:bg-white/10 transition-colors ${
                    dark ? 'hover:bg-slate-800' : ''
                  }`}
                >
                  Download copy
                </button>
              </div>
              <div
                ref={frameRef}
                className="flex-1 min-h-0 relative bg-white"
              >
                {unstable ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-8 text-center">
                    <div className="w-12 h-12 rounded-xl bg-amber-500/15 text-amber-500 flex items-center justify-center">
                      <AlertTriangle size={24} />
                    </div>
                    <div>
                      <p className="font-medium">The game keeps crashing and reloading itself.</p>
                      <p className={`mt-1 text-sm max-w-md ${subtle}`}>
                        The preview frame is too tight for it. Use the "New tab"
                        button above to run it in its own browser tab — that mode
                        has no restrictions and won't take this app down with it.
                      </p>
                    </div>
                    <button
                      onClick={openStandalone}
                      className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                    >
                      <ExternalLink size={15} />
                      Run in new tab
                    </button>
                  </div>
                ) : docSrc ? (
                  <iframe
                    key={`${activeEntry.path}-${nonce}`}
                    title="HTML preview"
                    src={docSrc}
                    onLoad={onFrameLoad}
                    className="absolute inset-0 w-full h-full border-0"
                    allow="fullscreen; pointer-lock; gamepad; autoplay; clipboard-write"
                  />
                ) : building || restoring ? (
                  <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400">
                    Loading…
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-emerald-500/15 text-emerald-500 flex items-center justify-center">
                <Globe2 size={28} />
              </div>
              <div>
                <h1 className="text-xl font-semibold tracking-tight">
                  Run HTML files from your device
                </h1>
                <p className={`mt-2 text-sm max-w-sm ${subtle}`}>
                  Open a single file or a whole project folder — linked CSS,
                  JavaScript, and images just work.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row gap-3">
                <button
                  onClick={pickFiles}
                  className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-medium transition-colors"
                >
                  <Upload size={16} />
                  Choose files
                </button>
                <button
                  onClick={pickFolder}
                  className={`flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border text-sm font-medium transition-colors ${
                    dark
                      ? 'border-slate-700 hover:bg-slate-800'
                      : 'border-slate-300 hover:bg-slate-50'
                  }`}
                >
                  <FolderOpen size={16} />
                  Choose folder
                </button>
              </div>
              <p className={`text-xs ${subtle}`}>
                Or drag and drop files here
              </p>
            </div>
          )}
          {error && (
            <div className="m-4 flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 text-red-500 px-4 py-3 text-sm">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}
        </main>

        {dragging && (
          <div className="absolute inset-0 z-20 bg-emerald-600/10 backdrop-blur-sm border-2 border-dashed border-emerald-500 flex items-center justify-center pointer-events-none">
            <p className="text-sm font-medium text-emerald-500">
              Drop files or folder to open
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
