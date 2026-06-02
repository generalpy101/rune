/**
 * Persists the workspace layout across restarts: tabs (with their split trees
 * and titles), which tab/pane was focused, sidebar width, the file-browser
 * root, the open preview, and each pane's last working directory (so restored
 * terminals respawn in the directory you left them in).
 *
 * PTYs themselves can't be serialized — only the shape and starting cwd are
 * restored; the shells start fresh.
 */
import type { PaneNode } from "./layout";
import { leafIds } from "./layout";

/** A named group of tabs (à la tmux/cmux). Each tab belongs to exactly one
 *  workspace; switching workspaces swaps the visible tab set while every
 *  workspace's terminals keep running in the background. */
export interface Workspace {
  id: number;
  name: string;
}

/** Workspace id assigned to tabs from sessions saved before workspaces existed
 *  (and the implicit first workspace). Safe because pane/tab ids start at ≥1
 *  and new ids are always allocated ≥3. */
export const DEFAULT_WS = 0;

export interface PersistedTab {
  id: number;
  title?: string;
  layout: PaneNode;
  /** Shell profile id this tab launches with (undefined = default shell). */
  profileId?: string;
  /** Workspace this tab lives in (undefined = the default workspace). */
  ws?: number;
}

export interface PersistedSession {
  tabs: PersistedTab[];
  activeTab: number;
  focusedPane: number;
  leftWidth: number;
  root: string;
  preview: string | null;
  /** Whether the file-browser sidebar is shown (undefined = shown). */
  sidebarOpen?: boolean;
  /** pane id -> last known cwd */
  paneCwd: Record<number, string>;
  /** Named workspaces (undefined/empty = a single implicit default workspace). */
  workspaces?: Workspace[];
  /** Currently selected workspace id. */
  activeWs?: number;
}

const KEY = "rustterm.session";

export function loadSession(): PersistedSession | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as PersistedSession;
    if (!Array.isArray(s.tabs) || s.tabs.length === 0) return null;
    return s;
  } catch {
    return null;
  }
}

export function saveSession(session: PersistedSession): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    /* ignore quota errors */
  }
}

/** Highest id used by any tab, split node, or pane — so new ids never collide. */
function maxNodeId(node: PaneNode): number {
  if (node.type === "leaf") return node.id;
  return Math.max(node.sid, maxNodeId(node.a), maxNodeId(node.b));
}

export function nextIdFor(session: PersistedSession): number {
  let max = session.focusedPane;
  for (const t of session.tabs) {
    max = Math.max(max, t.id, maxNodeId(t.layout));
  }
  for (const k in session.paneCwd) max = Math.max(max, Number(k));
  for (const w of session.workspaces ?? []) max = Math.max(max, w.id);
  return max + 1;
}

/** Drop cwd entries for panes that no longer exist in any tab. */
export function pruneCwd(
  tabs: PersistedTab[],
  paneCwd: Record<number, string>,
): Record<number, string> {
  const live = new Set<number>();
  for (const t of tabs) for (const id of leafIds(t.layout)) live.add(id);
  const out: Record<number, string> = {};
  for (const k in paneCwd) {
    if (live.has(Number(k))) out[Number(k)] = paneCwd[k];
  }
  return out;
}
