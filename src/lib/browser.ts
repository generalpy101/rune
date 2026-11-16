/**
 * Embedded browser panes. A browser pane is an ordinary leaf in a tab's split
 * tree whose id has an entry in `browserPanes`; Rust owns the native child
 * webview (see src-tauri/src/browser), keyed by that pane id.
 */
import { invoke } from "@tauri-apps/api/core";

/** Persisted per-pane state (by leaf id). */
export interface BrowserPaneState {
  /** Empty for a new tab that hasn't loaded a page yet. */
  url: string;
  title?: string;
}

/** Logical (CSS px) rectangle relative to the window's content area. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Page state reported by the Rust browser manager. */
export interface BrowserEvent {
  pane: number;
  kind: "loading" | "loaded" | "title" | "blocked" | "download";
  url: string;
  title?: string;
}

export const browserOpen = (pane: number, url: string, bounds: Bounds) =>
  invoke("browser_open", { pane, url, bounds });
export const browserNavigate = (pane: number, url: string) =>
  invoke("browser_navigate", { pane, url });
export const browserNav = (
  pane: number,
  action: "back" | "forward" | "reload",
) => invoke("browser_nav", { pane, action });
export const browserSetBounds = (pane: number, bounds: Bounds) =>
  invoke("browser_set_bounds", { pane, bounds });
export const browserSetVisible = (pane: number, visible: boolean) =>
  invoke("browser_set_visible", { pane, visible });
export const browserClose = (pane: number) => invoke("browser_close", { pane });
export const browserClearData = () => invoke("browser_clear_data");

/** A Chrome-family browser profile on this machine (Rust `ChromiumProfile`). */
export interface ChromiumProfile {
  browser: string;
  name: string;
  dir: string;
  hasBookmarks: boolean;
  hasCookies: boolean;
}

export interface BrowserBookmark {
  title: string;
  url: string;
  /** Folder path in the source browser, e.g. "Bookmarks bar/Docs". */
  folder: string;
}

export interface BookmarkImport {
  bookmarks: BrowserBookmark[];
  duplicates: number;
  skipped: number;
}

export interface CookieImport {
  found: number;
  imported: number;
  expired: number;
  unsupported: number;
  failed: number;
}

export const browserProfiles = () =>
  invoke<ChromiumProfile[]>("browser_profiles");
export const importBookmarks = (dir: string) =>
  invoke<BookmarkImport>("browser_import_bookmarks", { dir });
export const importCookies = (dir: string) =>
  invoke<CookieImport>("browser_import_cookies", { dir });

/** Only http(s) pages open in a pane (mirrors Rust `parse_url`). */
export function isWebUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.host;
  } catch {
    return false;
  }
}

/** Turn address-bar input into a URL: keeps explicit http(s) URLs, adds
 *  `http://` for local hosts and `https://` for anything else host-like.
 *  Returns null when the input can't be a web address. */
export function normalizeAddress(input: string): string | null {
  const t = input.trim();
  if (!t || /\s/.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return isWebUrl(t) ? t : null;
  const local = /^(localhost|127\.|\[::1\]|0\.0\.0\.0|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/i.test(t);
  const url = `${local ? "http" : "https"}://${t}`;
  return isWebUrl(url) ? url : null;
}

const BOOKMARKS_KEY = "rune.browserBookmarks";

/** Imported browser bookmarks live under their own key: they can number in
 *  the thousands, too big to rewrite on every settings or session save. */
export function loadBrowserBookmarks(): BrowserBookmark[] {
  try {
    const raw = localStorage.getItem(BOOKMARKS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveBrowserBookmarks(list: BrowserBookmark[]): void {
  try {
    localStorage.setItem(BOOKMARKS_KEY, JSON.stringify(list));
  } catch {
    /* ignore quota errors */
  }
}

/** Merge `incoming` into `existing`, deduping by normalized URL (the same
 *  WHATWG normalization Rust's `url` crate applies). Existing entries win. */
export function mergeBookmarks(
  existing: BrowserBookmark[],
  incoming: BrowserBookmark[],
): BrowserBookmark[] {
  const key = (u: string) => {
    try {
      return new URL(u).href;
    } catch {
      return u;
    }
  };
  const seen = new Set(existing.map((b) => key(b.url)));
  const merged = [...existing];
  for (const b of incoming) {
    const k = key(b.url);
    if (seen.has(k)) continue;
    seen.add(k);
    merged.push(b);
  }
  return merged;
}
