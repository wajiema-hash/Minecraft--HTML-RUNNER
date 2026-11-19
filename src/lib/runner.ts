import type { FileEntry } from './loader';

const EXTERNAL_RE = /^(data:|blob:|https?:|\/\/|mailto:|tel:|javascript:|#)/i;

const STORAGE_SHIM = `(function(){function shim(name){try{window[name].getItem("_");return}catch(e){}var s={};var api={getItem:function(k){return Object.prototype.hasOwnProperty.call(s,k)?s[k]:null},setItem:function(k,v){s[k]=String(v)},removeItem:function(k){delete s[k]},clear:function(){s={}},key:function(i){return Object.keys(s)[i]||null}};Object.defineProperty(api,"length",{get:function(){return Object.keys(s).length}});Object.defineProperty(window,name,{value:api})}shim("localStorage");shim("sessionStorage")})();`;

function normalizePath(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
}

function resolveRef(baseDir: string, ref: string): string {
  let clean = ref.split('#')[0].split('?')[0];
  try {
    clean = decodeURIComponent(clean);
  } catch {
    // keep raw value if it is not valid percent-encoding
  }
  if (clean.startsWith('/')) return normalizePath(clean);
  return normalizePath(`${baseDir}/${clean}`);
}

export async function buildDocument(entries: FileEntry[], htmlPath: string): Promise<string> {
  const map = new Map<string, File>();
  for (const e of entries) map.set(e.path.replace(/^\/+/, ''), e.file);

  const htmlFile = map.get(htmlPath);
  if (!htmlFile) throw new Error('File not found');

  const urlCache = new Map<string, string>();
  const cssCache = new Map<string, string>();

  const blobUrl = (path: string): string | null => {
    const file = map.get(path);
    if (!file) return null;
    let url = urlCache.get(path);
    if (!url) {
      url = URL.createObjectURL(file);
      urlCache.set(path, url);
    }
    return url;
  };

  const rewriteCssText = async (
    cssText: string,
    cssDir: string,
    seen: Set<string>
  ): Promise<string> => {
    const replaceRef = async (raw: string): Promise<string | null> => {
      if (!raw || EXTERNAL_RE.test(raw)) return null;
      const target = resolveRef(cssDir, raw);
      if (/\.css$/i.test(target)) {
        const url = await cssUrl(target, seen);
        return url;
      }
      return blobUrl(target);
    };

    let result = cssText;
    const urlMatches = Array.from(cssText.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g));
    for (const match of urlMatches) {
      const url = await replaceRef(match[2]);
      if (url) result = result.replace(match[0], `url("${url}")`);
    }
    const importMatches = Array.from(cssText.matchAll(/@import\s+(['"])([^'"]+)\1/g));
    for (const match of importMatches) {
      const url = await replaceRef(match[2]);
      if (url) result = result.replace(match[0], `@import "${url}"`);
    }
    return result;
  };

  const cssUrl = async (path: string, seen: Set<string>): Promise<string | null> => {
    const cached = cssCache.get(path);
    if (cached !== undefined) return cached || null;
    if (seen.has(path)) return null;
    seen.add(path);
    const file = map.get(path);
    if (!file) return null;
    const rewritten = await rewriteCssText(await file.text(), dirOf(path), seen);
    const url = URL.createObjectURL(new Blob([rewritten], { type: 'text/css' }));
    cssCache.set(path, url);
    return url;
  };

  const text = await htmlFile.text();
  const doc = new DOMParser().parseFromString(text, 'text/html');

  const baseHref = doc.querySelector('base[href]')?.getAttribute('href') ?? '';
  const baseDir = baseHref
    ? dirOf(resolveRef(dirOf(htmlPath), baseHref))
    : dirOf(htmlPath);

  const SRC_SELECTOR =
    'img[src], script[src], source[src], video[src], audio[src], embed[src], track[src], iframe[src]';
  for (const el of Array.from(doc.querySelectorAll(SRC_SELECTOR))) {
    const ref = el.getAttribute('src');
    if (!ref || EXTERNAL_RE.test(ref)) continue;
    const url = blobUrl(resolveRef(baseDir, ref));
    if (url) el.setAttribute('src', url);
  }

  for (const el of Array.from(doc.querySelectorAll('link[href]'))) {
    const ref = el.getAttribute('href');
    if (!ref || EXTERNAL_RE.test(ref)) continue;
    const target = resolveRef(baseDir, ref);
    const rel = el.getAttribute('rel') ?? '';
    if (/\bstylesheet\b/i.test(rel) && /\.css$/i.test(target)) {
      const url = await cssUrl(target, new Set());
      if (url) el.setAttribute('href', url);
    } else {
      const url = blobUrl(target);
      if (url) el.setAttribute('href', url);
    }
  }

  for (const el of Array.from(doc.querySelectorAll('[srcset]'))) {
    const value = el.getAttribute('srcset');
    if (!value) continue;
    const rewritten = value
      .split(',')
      .map((part) => {
        const trimmed = part.trim();
        if (!trimmed) return trimmed;
        const [ref, ...rest] = trimmed.split(/\s+/);
        if (EXTERNAL_RE.test(ref)) return trimmed;
        const url = blobUrl(resolveRef(baseDir, ref));
        return url ? [url, ...rest].join(' ') : trimmed;
      })
      .join(', ');
    el.setAttribute('srcset', rewritten);
  }

  for (const el of Array.from(doc.querySelectorAll('a[href]'))) {
    const ref = el.getAttribute('href');
    if (!ref || EXTERNAL_RE.test(ref)) continue;
    const target = resolveRef(baseDir, ref);
    if (!map.has(target)) continue;
    const url = blobUrl(target);
    if (url) {
      el.setAttribute('href', url);
      if (/\.html?$/i.test(target)) el.setAttribute('target', '_blank');
    }
  }

  for (const el of Array.from(doc.querySelectorAll('style'))) {
    el.textContent = await rewriteCssText(el.textContent ?? '', baseDir, new Set());
  }

  if (!doc.querySelector('meta[charset]')) {
    const meta = doc.createElement('meta');
    meta.setAttribute('charset', 'utf-8');
    doc.head?.prepend(meta);
  }
  const shim = doc.createElement('script');
  shim.textContent = STORAGE_SHIM;
  doc.head?.prepend(shim);

  return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
}
