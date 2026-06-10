import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalPane, type TerminalHandle } from "./components/TerminalPane";
import { FileBrowser } from "./components/FileBrowser";
import {
  EditorArea,
  itemKey,
  type EditorItem,
  type EditorAreaHandle,
} from "./components/EditorArea";
import { confirmDialog, alertDialog } from "./lib/dialogs";
import { SettingsModal } from "./components/SettingsModal";
import { QuickOpen } from "./components/QuickOpen";
import { CommandPalette, type Command } from "./components/CommandPalette";
import { AIPanel } from "./components/AIPanel";
import { AISettings } from "./components/AISettings";
import { ActivityMonitor } from "./components/ActivityMonitor";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { StatusBar } from "./components/StatusBar";
import { homeDir, revealInFinder } from "./lib/fs";
import { checkUpdate, installUpdate } from "./lib/update";
import {
  loadSettings,
  saveSettings,
  applyTheme,
  profileSpawn,
  sshSpawn,
  themeOptions,
  DEFAULT_SETTINGS,
  type Settings,
  type Profile,
  type SshHost,
} from "./lib/settings";
import type { SpawnProfile } from "./lib/pty";
import { agentSpawn } from "./lib/pty";
import { runMeta } from "./lib/meta";
import { getCurrentWindow, Effect } from "@tauri-apps/api/window";
import {
  IconPlus,
  IconClose,
  IconSearch,
  IconSparkle,
  IconSettings,
  IconPalette,
  IconChevronUp,
  IconChevronDown,
  IconSidebar,
  IconBroadcast,
  IconSplitRight,
  IconSplitDown,
  IconZen,
  IconZenExit,
} from "./lib/icons";
import { loadAiConfig, saveAiConfig, type AiConfig } from "./lib/ai/config";
import {
  loadSession,
  saveSession,
  nextIdFor,
  pruneCwd,
  DEFAULT_WS,
  type Workspace,
} from "./lib/session";
import {
  leaf,
  leafIds,
  firstLeafId,
  splitLeaf,
  removeLeaf,
  setRatio,
  computeLayout,
  type PaneNode,
} from "./lib/layout";
import "./App.css";

/** Shell-quote a path for a `cd` command. */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

interface Tab {
  id: number;
  title?: string;
  layout: PaneNode;
  /** Shell profile this tab's terminals launch with. Undefined = default shell. */
  profileId?: string;
  /** Explicit spawn override (e.g. an SSH connection). Wins over `profileId`.
   *  Plain data, so it survives session persistence + reattach across reloads. */
  spawn?: SpawnProfile;
  /** Workspace this tab belongs to. Tabs of inactive workspaces stay mounted
   *  (terminals keep running) but hidden. */
  ws: number;
}

/** Coding-agent CLIs that can be launched in a terminal. They run through the
 *  user's own shell and use the CLI's own authentication — no API key needed.
 *  Claude Code is intentionally omitted for now: Anthropic restricts
 *  third-party programmatic access to Claude from 2026-06-15, so launching the
 *  `claude` CLI on a user's behalf isn't permitted. Add it back here when that
 *  changes — the launch flow is already agent-agnostic. */
const AGENTS = [
  {
    id: "codex",
    name: "Codex",
    command: "codex",
    install: "npm i -g @openai/codex   (then run: codex login)",
  },
] as const;

type Agent = (typeof AGENTS)[number];

export default function App() {
  const [initial] = useState(loadSession);

  const [home, setHome] = useState<string | null>(null);
  const [root, setRoot] = useState<string | null>(() => initial?.root ?? null);
  const [openItems, setOpenItems] = useState<EditorItem[]>(() => {
    if (initial?.openItems?.length) return initial.openItems;
    if (initial?.preview) return [{ kind: "file", path: initial.preview }];
    return [];
  });
  const [activeKey, setActiveKey] = useState<string | null>(() => {
    if (initial?.activeKey) return initial.activeKey;
    if (initial?.openItems?.length) return itemKey(initial.openItems[0]);
    if (initial?.preview) return `file:${initial.preview}`;
    return null;
  });
  const openItemsRef = useRef(openItems);
  openItemsRef.current = openItems;
  const activeKeyRef = useRef(activeKey);
  activeKeyRef.current = activeKey;
  // Bumped after a save to refresh git status (file-browser badges).
  const [gitNonce, setGitNonce] = useState(0);
  const editorRef = useRef<EditorAreaHandle>(null);

  const openFile = useCallback((path: string) => {
    const key = `file:${path}`;
    setOpenItems((its) =>
      its.some((i) => itemKey(i) === key)
        ? its
        : [...its, { kind: "file", path }],
    );
    setActiveKey(key);
  }, []);

  const openDiff = useCallback((path: string) => {
    const key = `diff:${path}`;
    setOpenItems((its) =>
      its.some((i) => itemKey(i) === key)
        ? its
        : [...its, { kind: "diff", path }],
    );
    setActiveKey(key);
  }, []);

  const closeItem = useCallback((key: string) => {
    const its = openItemsRef.current;
    const idx = its.findIndex((i) => itemKey(i) === key);
    if (idx === -1) return;
    const next = its.filter((i) => itemKey(i) !== key);
    setOpenItems(next);
    if (activeKeyRef.current === key) {
      setActiveKey(
        next.length ? itemKey(next[Math.min(idx, next.length - 1)]) : null,
      );
    }
  }, []);

  const [leftWidth, setLeftWidth] = useState(() => initial?.leftWidth ?? 280);
  const [sidebarOpen, setSidebarOpen] = useState(
    () => initial?.sidebarOpen ?? true,
  );
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [quickOpen, setQuickOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  // Zen mode: hide all chrome (top bar, sidebar, status bar) for a
  // distraction-free terminal. Transient — not persisted across restarts.
  const [zen, setZen] = useState(false);
  const [aiConfig, setAiConfig] = useState<AiConfig>(loadAiConfig);
  const [showAi, setShowAi] = useState(false);
  const [showAiSettings, setShowAiSettings] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>(() =>
    (initial?.tabs ?? [{ id: 1, layout: leaf(2) }]).map((t) => ({
      ...t,
      ws: t.ws ?? DEFAULT_WS,
    })),
  );
  // Named workspaces. Sessions saved before workspaces existed migrate to a
  // single "Main" workspace holding all their (default-ws) tabs.
  const [workspaces, setWorkspaces] = useState<Workspace[]>(() =>
    initial?.workspaces?.length
      ? initial.workspaces
      : [{ id: DEFAULT_WS, name: "Main" }],
  );
  const [activeWs, setActiveWs] = useState<number>(
    () => initial?.activeWs ?? initial?.workspaces?.[0]?.id ?? DEFAULT_WS,
  );
  const [editingWs, setEditingWs] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState(() => initial?.activeTab ?? 1);
  const [focusedPane, setFocusedPane] = useState(
    () => initial?.focusedPane ?? 2,
  );
  const [editingTab, setEditingTab] = useState<number | null>(null);
  const [newTabMenu, setNewTabMenu] = useState(false);
  // When set, the focused pane is shown maximized within its tab (⌘⏎).
  const [zoomedPane, setZoomedPane] = useState<number | null>(null);
  // Dimensions of the focused terminal, shown in the status bar.
  const [dims, setDims] = useState<{ rows: number; cols: number } | null>(null);
  const [search, setSearch] = useState<{ open: boolean; term: string }>({
    open: false,
    term: "",
  });
  // Broadcast input: mirror keystrokes from the focused pane to every other
  // pane in the active tab (handy for running the same command across SSH
  // sessions / split panes).
  const [broadcast, setBroadcast] = useState(false);
  // Tab ids that have produced output while in the background (cleared when
  // the tab is selected). Drives the unread-activity dot on tabs.
  const [activity, setActivity] = useState<Set<number>>(() => new Set());

  // Latest settings in a ref so tab-creation callbacks can read profiles
  // without taking `settings` as a dependency (which would churn the keyboard
  // shortcut listener on every settings change).
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Latest tabs/focus in refs so the stable keyboard-shortcut callbacks (which
  // intentionally have empty dep arrays) can read current values.
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const focusedPaneRef = useRef(focusedPane);
  focusedPaneRef.current = focusedPane;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const activeWsRef = useRef(activeWs);
  activeWsRef.current = activeWs;
  const workspacesRef = useRef(workspaces);
  workspacesRef.current = workspaces;
  // Remembers each workspace's last active tab + focused pane, so switching
  // back restores where you were.
  const wsLast = useRef(new Map<number, { tab: number; pane: number }>());

  const profileById = useCallback(
    (id?: string | null): Profile | null =>
      settings.profiles.find((p) => p.id === id) ?? null,
    [settings.profiles],
  );

  const nextId = useRef(initial ? nextIdFor(initial) : 3);
  const handles = useRef(new Map<number, TerminalHandle>());
  const refCbs = useRef(new Map<number, (h: TerminalHandle | null) => void>());
  // Per-pane working directory; drives initial spawn cwd and is persisted so a
  // restored session reopens each terminal where it was left.
  const paneCwd = useRef<Map<number, string>>(
    new Map(
      initial
        ? Object.entries(initial.paneCwd).map(([k, v]) => [Number(k), v])
        : [],
    ),
  );
  const dragging = useRef(false);
  const dragTab = useRef<number | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  // The two independently-scrolling strips (workspaces / tabs); we scroll the
  // active item into view when it changes so ⌘1-9 / ⌘⇧←→ never select an
  // off-screen item.
  const tabScrollRef = useRef<HTMLDivElement>(null);
  const wsScrollRef = useRef<HTMLDivElement>(null);
  // Stack of recently closed tabs for ⌘⇧T (reopen). Captures the layout, title,
  // profile and the cwds of each pane so the tab restores where it left off.
  const closedTabs = useRef<{ tab: Tab; cwds: [number, string][] }[]>([]);

  const getRefCb = (id: number) => {
    let cb = refCbs.current.get(id);
    if (!cb) {
      cb = (h) => {
        if (h) handles.current.set(id, h);
        else {
          handles.current.delete(id);
          refCbs.current.delete(id);
        }
      };
      refCbs.current.set(id, cb);
    }
    return cb;
  };

  const activeHandle = () => handles.current.get(focusedPane);

  // True if confirmation says it's OK to close panes `ids` (none busy, or the
  // user accepted the prompt). Honors the confirmCloseRunning setting.
  const okToClose = async (ids: number[]): Promise<boolean> => {
    if (!settingsRef.current.confirmCloseRunning) return true;
    const busy = ids.some((id) => handles.current.get(id)?.isBusy());
    if (!busy) return true;
    return confirmDialog(
      "A command is still running. Close anyway and terminate it?",
    );
  };

  // Navigate the workspace root (file browser + agent cwd) and move the focused
  // shell there too, so all three stay consistent and the choice "sticks"
  // instead of being overwritten by the terminal's cwd poll.
  const navigateRoot = useCallback(
    (p: string) => {
      setRoot(p);
      handles.current.get(focusedPane)?.sendText(`cd ${shellQuote(p)}\n`);
    },
    [focusedPane],
  );

  // Switch tabs and focus that tab's first pane.
  const selectTab = useCallback((id: number) => {
    setActiveTab(id);
    setTabs((prev) => {
      const tab = prev.find((t) => t.id === id);
      if (tab) setFocusedPane(firstLeafId(tab.layout));
      return prev;
    });
  }, []);

  // Open a new tab. `profileId` defaults to the configured default profile; the
  // profile's startup directory (if any) sets the terminal's initial cwd.
  const newTab = useCallback((profileId?: string | null) => {
    const s = settingsRef.current;
    const pid_ = profileId === undefined ? s.defaultProfileId : profileId;
    const prof = s.profiles.find((p) => p.id === pid_) ?? null;
    const tid = nextId.current++;
    const pid = nextId.current++;
    if (prof?.cwd && prof.cwd.trim()) paneCwd.current.set(pid, prof.cwd.trim());
    setTabs((t) => [
      ...t,
      { id: tid, ws: activeWsRef.current, layout: leaf(pid), profileId: pid_ ?? undefined },
    ]);
    setActiveTab(tid);
    setFocusedPane(pid);
  }, []);

  // New tab whose terminal starts in `cwd` (uses the default profile).
  const newTabAt = useCallback((cwd: string) => {
    const tid = nextId.current++;
    const pid = nextId.current++;
    paneCwd.current.set(pid, cwd);
    const profileId = settingsRef.current.defaultProfileId ?? undefined;
    setTabs((t) => [
      ...t,
      { id: tid, ws: activeWsRef.current, layout: leaf(pid), profileId },
    ]);
    setActiveTab(tid);
    setFocusedPane(pid);
  }, []);

  // Open a new tab connected to a saved SSH host (runs the system `ssh`
  // client). Optionally switches theme as a visual cue you're on a remote box.
  const connectSsh = useCallback((host: SshHost) => {
    const tid = nextId.current++;
    const pid = nextId.current++;
    setTabs((t) => [
      ...t,
      {
        id: tid,
        ws: activeWsRef.current,
        title: host.name,
        layout: leaf(pid),
        spawn: sshSpawn(host),
      },
    ]);
    setActiveTab(tid);
    setFocusedPane(pid);
    if (host.themeId) setSettings((s) => ({ ...s, theme: host.themeId! }));
  }, []);

  // Open a new tab running a coding-agent CLI (e.g. Codex). The CLI is launched
  // through the user's login shell (so its PATH/auth load) in the current pane's
  // directory. If it isn't installed, prompt with install instructions.
  const launchAgent = useCallback(async (agent: Agent) => {
    const launch = await agentSpawn(agent.command).catch(() => null);
    if (!launch) {
      await alertDialog(
        `${agent.name} CLI was not found on your PATH. Install it with: ${agent.install}`,
      );
      return;
    }
    const tid = nextId.current++;
    const pid = nextId.current++;
    const cwd = paneCwd.current.get(focusedPaneRef.current);
    if (cwd) paneCwd.current.set(pid, cwd);
    setTabs((t) => [
      ...t,
      {
        id: tid,
        ws: activeWsRef.current,
        title: agent.name,
        layout: leaf(pid),
        spawn: { shell: launch.shell, args: launch.args },
      },
    ]);
    setActiveTab(tid);
    setFocusedPane(pid);
  }, []);

  const closeTab = useCallback(async (id: number) => {
    const tab = tabsRef.current.find((t) => t.id === id);
    if (tab) {
      if (!(await okToClose(leafIds(tab.layout)))) return;
      // Remember it so ⌘⇧T can bring it back where it left off.
      const cwds = leafIds(tab.layout)
        .map((lid) => [lid, paneCwd.current.get(lid)] as [number, string | undefined])
        .filter((e): e is [number, string] => e[1] != null);
      closedTabs.current.push({ tab, cwds });
      if (closedTabs.current.length > 20) closedTabs.current.shift();
    }
    const ws = tab?.ws ?? activeWsRef.current;
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      const wsTabs = next.filter((t) => t.ws === ws);
      if (wsTabs.length === 0) {
        // Workspace emptied — keep it alive with a fresh terminal.
        const tid = nextId.current++;
        const pid = nextId.current++;
        setActiveTab(tid);
        setFocusedPane(pid);
        return [...next, { id: tid, ws, layout: leaf(pid) }];
      }
      setActiveTab((cur) => {
        if (cur !== id) return cur;
        const fallback = wsTabs[wsTabs.length - 1];
        setFocusedPane(firstLeafId(fallback.layout));
        return fallback.id;
      });
      return next;
    });
  }, []);

  // Reopen the most-recently closed tab (⌘⇧T), restoring its panes' cwds.
  const reopenTab = useCallback(() => {
    const last = closedTabs.current.pop();
    if (!last) return;
    for (const [id, cwd] of last.cwds) paneCwd.current.set(id, cwd);
    // Keep the id allocator ahead of any ids we just restored.
    const maxId = Math.max(last.tab.id, ...leafIds(last.tab.layout));
    if (nextId.current <= maxId) nextId.current = maxId + 1;
    // If the tab's original workspace is gone, drop it into the current one,
    // and switch to its workspace so it's visible.
    const wsExists = workspacesRef.current.some((w) => w.id === last.tab.ws);
    const tab = wsExists ? last.tab : { ...last.tab, ws: activeWsRef.current };
    setTabs((prev) => [...prev, tab]);
    setActiveWs(tab.ws);
    setActiveTab(tab.id);
    setFocusedPane(firstLeafId(tab.layout));
  }, []);

  const renameTab = useCallback((id: number, title: string) => {
    const t = title.trim();
    setTabs((prev) =>
      prev.map((tab) =>
        tab.id === id ? { ...tab, title: t || undefined } : tab,
      ),
    );
  }, []);

  const reorderTabs = useCallback((fromId: number, toId: number) => {
    if (fromId === toId) return;
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === fromId);
      const to = prev.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }, []);

  // Split the focused pane in two; the new pane inherits its cwd and takes focus.
  const splitFocused = useCallback(
    (dir: "row" | "col") => {
      const pid = nextId.current++;
      const sid = nextId.current++;
      const cur = paneCwd.current.get(focusedPane);
      if (cur) paneCwd.current.set(pid, cur);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === activeTab
            ? { ...t, layout: splitLeaf(t.layout, focusedPane, dir, pid, sid) }
            : t,
        ),
      );
      setFocusedPane(pid);
    },
    [activeTab, focusedPane],
  );

  // Close a specific pane; closes the whole tab when it's the last pane. The
  // pane belongs to the active tab (only active-tab panes are interactable).
  const closePane = useCallback(
    async (paneId: number) => {
      const tab = tabsRef.current.find((t) => t.id === activeTabRef.current);
      if (!tab) return;
      if (leafIds(tab.layout).length <= 1) {
        await closeTab(tab.id);
        return;
      }
      if (!(await okToClose([paneId]))) return;
      const newLayout = removeLeaf(tab.layout, paneId);
      if (!newLayout) return;
      const remaining = leafIds(newLayout);
      setFocusedPane(remaining[remaining.length - 1]);
      setTabs((prev) =>
        prev.map((t) => (t.id === tab.id ? { ...t, layout: newLayout } : t)),
      );
    },
    [closeTab],
  );

  // Close the focused pane (⌘W).
  const closeFocused = useCallback(() => {
    void closePane(focusedPaneRef.current);
  }, [closePane]);

  const applyRatio = useCallback((sid: number, ratio: number) => {
    setTabs((prev) =>
      prev.map((t) => ({ ...t, layout: setRatio(t.layout, sid, ratio) })),
    );
  }, []);

  const clearFocused = useCallback(() => activeHandle()?.clear(), [focusedPane]);

  // Cycle the active tab by `delta` within the current workspace (wraps).
  const cycleTab = useCallback((delta: number) => {
    const ts = tabsRef.current.filter((t) => t.ws === activeWsRef.current);
    if (ts.length < 2) return;
    const idx = ts.findIndex((t) => t.id === activeTabRef.current);
    const next = ts[(idx + delta + ts.length) % ts.length];
    setActiveTab(next.id);
    setFocusedPane(firstLeafId(next.layout));
  }, []);

  // --- Workspaces ---------------------------------------------------------

  // Switch to another workspace, restoring its last active tab/pane (or its
  // first tab; creating one if the workspace is somehow empty).
  const switchWs = useCallback((wsId: number) => {
    if (wsId === activeWsRef.current) return;
    wsLast.current.set(activeWsRef.current, {
      tab: activeTabRef.current,
      pane: focusedPaneRef.current,
    });
    setActiveWs(wsId);
    const wsTabs = tabsRef.current.filter((t) => t.ws === wsId);
    const remembered = wsLast.current.get(wsId);
    const target =
      (remembered && wsTabs.find((t) => t.id === remembered.tab)) || wsTabs[0];
    if (target) {
      setActiveTab(target.id);
      const pane =
        remembered && leafIds(target.layout).includes(remembered.pane)
          ? remembered.pane
          : firstLeafId(target.layout);
      setFocusedPane(pane);
    } else {
      const tid = nextId.current++;
      const pid = nextId.current++;
      setTabs((t) => [...t, { id: tid, ws: wsId, layout: leaf(pid) }]);
      setActiveTab(tid);
      setFocusedPane(pid);
    }
  }, []);

  // Create a new workspace (with one fresh terminal) and switch to it.
  const addWorkspace = useCallback(() => {
    const wid = nextId.current++;
    const tid = nextId.current++;
    const pid = nextId.current++;
    wsLast.current.set(activeWsRef.current, {
      tab: activeTabRef.current,
      pane: focusedPaneRef.current,
    });
    setWorkspaces((w) => [...w, { id: wid, name: `Workspace ${w.length + 1}` }]);
    setTabs((t) => [...t, { id: tid, ws: wid, layout: leaf(pid) }]);
    setActiveWs(wid);
    setActiveTab(tid);
    setFocusedPane(pid);
  }, []);

  const renameWorkspace = useCallback((id: number, name: string) => {
    const n = name.trim();
    setWorkspaces((w) =>
      w.map((x) => (x.id === id ? { ...x, name: n || x.name } : x)),
    );
  }, []);

  // Delete a workspace and close all its terminals (unmounting kills the PTYs).
  // The last remaining workspace can't be deleted.
  const deleteWorkspace = useCallback(async (id: number) => {
    if (workspacesRef.current.length <= 1) return;
    const victimPanes = tabsRef.current
      .filter((t) => t.ws === id)
      .flatMap((t) => leafIds(t.layout));
    if (!(await okToClose(victimPanes))) return;
    const remaining = workspacesRef.current.filter((w) => w.id !== id);
    setTabs((prev) => prev.filter((t) => t.ws !== id));
    setWorkspaces(remaining);
    wsLast.current.delete(id);
    if (activeWsRef.current === id) {
      // Move to a sibling workspace and surface its active tab.
      const nextWs = remaining[0];
      activeWsRef.current = nextWs.id; // avoid switchWs's same-ws early return
      setActiveWs(nextWs.id);
      const wsTabs = tabsRef.current.filter(
        (t) => t.ws === nextWs.id && t.id !== id,
      );
      const remembered = wsLast.current.get(nextWs.id);
      const target =
        (remembered && wsTabs.find((t) => t.id === remembered.tab)) ||
        wsTabs[0];
      if (target) {
        setActiveTab(target.id);
        setFocusedPane(firstLeafId(target.layout));
      }
    }
  }, []);

  // Cycle to the previous/next workspace (wraps).
  const cycleWs = useCallback(
    (delta: number) => {
      const ws = workspacesRef.current;
      if (ws.length < 2) return;
      const idx = ws.findIndex((w) => w.id === activeWsRef.current);
      switchWs(ws[(idx + delta + ws.length) % ws.length].id);
    },
    [switchWs],
  );

  // Cycle the focused pane within the active tab by `delta` (wraps around).
  const cyclePane = useCallback((delta: number) => {
    const tab = tabsRef.current.find((t) => t.id === activeTabRef.current);
    if (!tab) return;
    const ids = leafIds(tab.layout);
    if (ids.length < 2) return;
    const idx = ids.indexOf(focusedPaneRef.current);
    setFocusedPane(ids[(idx + delta + ids.length) % ids.length]);
  }, []);

  // Toggle maximize ("zoom") of the focused pane within its tab.
  const toggleZoom = useCallback(() => {
    setZoomedPane((z) => (z === focusedPaneRef.current ? null : focusedPaneRef.current));
    // Re-fit after the layout swaps.
    requestAnimationFrame(() =>
      handles.current.get(focusedPaneRef.current)?.refit(),
    );
  }, []);

  // Bump the terminal font size (delta) or reset it (delta === 0).
  const zoomFont = useCallback((delta: number) => {
    setSettings((s) => {
      const size =
        delta === 0
          ? DEFAULT_SETTINGS.fontSize
          : Math.min(32, Math.max(8, s.fontSize + delta));
      return { ...s, fontSize: size };
    });
  }, []);

  const checkForUpdate = useCallback(async () => {
    try {
      const info = await checkUpdate();
      if (!info.available) {
        await alertDialog("You're on the latest version.");
        return;
      }
      const go = await confirmDialog(
        `Update ${info.version ?? ""} is available.${
          info.notes ? `\n\n${info.notes}` : ""
        }\n\nDownload and install now?`,
      );
      if (go) {
        await installUpdate();
        await alertDialog("Update installed. Please restart Rune.");
      }
    } catch (e) {
      await alertDialog(`Update check failed: ${e}`);
    }
  }, []);

  // Clear the unread-activity marker for whichever tab becomes active.
  useEffect(() => {
    setActivity((prev) => {
      if (!prev.has(activeTab)) return prev;
      const next = new Set(prev);
      next.delete(activeTab);
      return next;
    });
  }, [activeTab]);

  // Persist settings.
  useEffect(() => saveSettings(settings), [settings]);

  // Keep the active tab / workspace scrolled into view within their (now
  // separate) horizontal strips, so keyboard selection of an off-screen item
  // brings it into view.
  useEffect(() => {
    tabScrollRef.current
      ?.querySelector(".tab.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeTab]);
  useEffect(() => {
    wsScrollRef.current
      ?.querySelector(".ws-pill.active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeWs]);

  // Drive the whole-app chrome palette from the selected theme (built-in or
  // custom). Reacts to any settings change so live theme edits apply at once.
  useEffect(() => applyTheme(settings), [settings]);

  // macOS window vibrancy (opt-in). Applies a translucent material behind the
  // app and flips a root class so the CSS can let it show through. Disabling
  // clears the effect and restores the opaque background. Best-effort.
  useEffect(() => {
    const win = getCurrentWindow();
    const root = document.documentElement;
    if (settings.translucent) {
      root.classList.add("translucent");
      win
        .setEffects({ effects: [Effect.UnderWindowBackground] })
        .catch(() => {});
    } else {
      root.classList.remove("translucent");
      win.clearEffects().catch(() => {});
    }
  }, [settings.translucent]);

  // Persist AI config (providers, keys, toggles).
  useEffect(() => saveAiConfig(aiConfig), [aiConfig]);

  // Persist the workspace whenever its shape changes. paneCwd (a ref) is read
  // at save time; cwd changes also bump `root`, so they get flushed here too.
  useEffect(() => {
    if (root === null) return;
    saveSession({
      tabs,
      activeTab,
      focusedPane,
      leftWidth,
      root,
      openItems,
      activeKey,
      sidebarOpen,
      workspaces,
      activeWs,
      paneCwd: pruneCwd(
        tabs,
        Object.fromEntries(paneCwd.current),
      ),
    });
  }, [
    tabs,
    activeTab,
    focusedPane,
    leftWidth,
    root,
    openItems,
    activeKey,
    sidebarOpen,
    workspaces,
    activeWs,
  ]);

  // Resolve home directory before mounting terminals (avoids a respawn).
  useEffect(() => {
    homeDir()
      .then((h) => {
        setHome(h);
        setRoot((r) => r ?? h);
      })
      .catch(() => {
        setHome("/");
        setRoot((r) => r ?? "/");
      });
  }, []);

  // Sidebar drag-resize.
  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return;
      setLeftWidth(Math.min(Math.max(e.clientX, 160), 600));
    };
    const up = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    return () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
  }, []);

  // Global keyboard shortcuts.
  useEffect(() => {
    const editorHasFocus = () =>
      !!document.activeElement?.closest(".editor-area");
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      // ⌘⌥ + arrows: cycle tabs (←/→) or focus another pane (↑/↓).
      if (e.altKey) {
        if (e.key === "ArrowLeft") {
          e.preventDefault();
          cycleTab(-1);
          return;
        } else if (e.key === "ArrowRight") {
          e.preventDefault();
          cycleTab(1);
          return;
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          cyclePane(-1);
          return;
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          cyclePane(1);
          return;
        }
      }
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && e.shiftKey) {
        // ⌘⇧←/→: switch to the previous/next workspace.
        e.preventDefault();
        cycleWs(e.key === "ArrowLeft" ? -1 : 1);
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // ⌘↑/⌘↓: jump to the previous/next shell prompt (OSC 133 blocks).
        e.preventDefault();
        handles.current
          .get(focusedPaneRef.current)
          ?.jumpPrompt(e.key === "ArrowUp" ? -1 : 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        toggleZoom();
      } else if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        zoomFont(1);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        zoomFont(-1);
      } else if (e.key === "0") {
        e.preventDefault();
        zoomFont(0);
      } else if (e.key === "t" && e.shiftKey) {
        e.preventDefault();
        reopenTab();
      } else if (e.key === "t") {
        e.preventDefault();
        newTab();
      } else if (e.code === "BracketRight" && e.shiftKey && editorHasFocus()) {
        // ⌘⇧]: next editor tab.
        e.preventDefault();
        editorRef.current?.nextTab();
      } else if (e.code === "BracketLeft" && e.shiftKey && editorHasFocus()) {
        // ⌘⇧[: previous editor tab.
        e.preventDefault();
        editorRef.current?.prevTab();
      } else if (e.key === "w") {
        e.preventDefault();
        // ⌘W closes the focused editor tab when editing, else the pane.
        if (editorHasFocus() && openItemsRef.current.length > 0) {
          editorRef.current?.closeActive();
        } else {
          closeFocused();
        }
      } else if (e.key === "d") {
        e.preventDefault();
        splitFocused(e.shiftKey ? "col" : "row");
      } else if (e.key === "k") {
        e.preventDefault();
        clearFocused();
      } else if (e.key === "f") {
        e.preventDefault();
        setSearch((s) => ({ ...s, open: true }));
        requestAnimationFrame(() => searchInputRef.current?.focus());
      } else if (e.key === "p" && e.shiftKey) {
        e.preventDefault();
        setPalette(true);
      } else if (e.key === "i") {
        e.preventDefault();
        setShowAi((v) => !v);
      } else if (e.key === ".") {
        // ⌘.: toggle zen mode (distraction-free terminal).
        e.preventDefault();
        setZen((v) => !v);
      } else if (e.key === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      } else if (e.key === "p") {
        e.preventDefault();
        setQuickOpen(true);
      } else if (e.key >= "1" && e.key <= "9") {
        // ⌘1-9 selects the Nth editor tab when editing, else the Nth terminal
        // tab within the current workspace.
        e.preventDefault();
        const idx = Number(e.key) - 1;
        if (editorHasFocus() && openItemsRef.current[idx]) {
          setActiveKey(itemKey(openItemsRef.current[idx]));
        } else {
          const wsTabs = tabsRef.current.filter(
            (t) => t.ws === activeWsRef.current,
          );
          if (wsTabs[idx]) selectTab(wsTabs[idx].id);
        }
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKey, { capture: true });
  }, [
    newTab,
    closeFocused,
    splitFocused,
    clearFocused,
    selectTab,
    cycleTab,
    cyclePane,
    cycleWs,
    toggleZoom,
    zoomFont,
    reopenTab,
  ]);

  const closeSearch = () => {
    setSearch({ open: false, term: "" });
    activeHandle()?.clearSearch();
    activeHandle()?.focus();
  };

  // Dispatch a meta command typed in the terminal (via the `rt` shell function,
  // which emits an OSC escape that TerminalPane forwards here). Returns text to
  // print back into the invoking terminal, or nothing for state changes.
  const handleMeta = (payload: string): string | void =>
    runMeta(payload, {
      runSnippet: (q) => {
        const ql = q.toLowerCase();
        const list = settings.snippets;
        const found =
          list.find((s) => s.name.toLowerCase() === ql || s.id === q) ??
          list.find((s) => s.name.toLowerCase().startsWith(ql));
        if (!found) return false;
        activeHandle()?.sendText(found.command + "\n");
        return true;
      },
      listSnippets: () =>
        settings.snippets.map((s) => ({ name: s.name, command: s.command })),
      connectSsh: (q) => {
        const ql = q.toLowerCase();
        const list = settings.sshHosts;
        const found =
          list.find((h) => h.name.toLowerCase() === ql || h.id === q) ??
          list.find((h) => h.name.toLowerCase().startsWith(ql));
        if (!found) return false;
        connectSsh(found);
        return true;
      },
      listSshHosts: () =>
        settings.sshHosts.map((h) => ({
          name: h.name,
          target: h.user ? `${h.user}@${h.host}` : h.host,
        })),
      setTheme: (id) => {
        const il = id.toLowerCase();
        const opt = themeOptions(settings).find(
          (o) => o.id.toLowerCase() === il || o.label.toLowerCase() === il,
        );
        if (!opt) return false;
        setSettings((s) => ({ ...s, theme: opt.id }));
        return true;
      },
      themeNames: () => themeOptions(settings),
      split: (dir) => splitFocused(dir),
      closePane: () => closeFocused(),
      newTab: () => newTab(),
      toggleSidebar: () => setSidebarOpen((v) => !v),
      toggleAi: () => setShowAi((v) => !v),
      clearTerminal: () => activeHandle()?.clear(),
    });

  // Commands for the ⌘⇧P palette.
  const buildCommands = (): Command[] => [
    { id: "newtab", label: "New Tab", hint: "⌘T", run: () => newTab() },
    {
      id: "new-workspace",
      label: "New Workspace",
      run: addWorkspace,
    },
    ...workspaces
      .filter((w) => w.id !== activeWs)
      .map((w) => ({
        id: `ws-${w.id}`,
        label: `Switch to Workspace: ${w.name}`,
        hint: "⌘⇧←/→",
        run: () => switchWs(w.id),
      })),
    ...settings.profiles.map((p) => ({
      id: `newtab-${p.id}`,
      label: `New Tab: ${p.name}`,
      run: () => newTab(p.id),
    })),
    ...settings.sshHosts.map((h) => ({
      id: `ssh-${h.id}`,
      label: `SSH: ${h.name}`,
      hint: h.user ? `${h.user}@${h.host}` : h.host,
      run: () => connectSsh(h),
    })),
    ...AGENTS.map((a) => ({
      id: `agent-${a.id}`,
      label: `New ${a.name} Session`,
      run: () => {
        void launchAgent(a);
      },
    })),
    {
      id: "split-right",
      label: "Split Pane Right",
      hint: "⌘D",
      run: () => splitFocused("row"),
    },
    {
      id: "split-down",
      label: "Split Pane Down",
      hint: "⌘⇧D",
      run: () => splitFocused("col"),
    },
    { id: "close", label: "Close Pane", hint: "⌘W", run: closeFocused },
    ...(activeKey?.startsWith("file:")
      ? [
          {
            id: "view-diff",
            label: "View Diff (vs HEAD)",
            run: () => openDiff(activeKey.slice("file:".length)),
          },
        ]
      : []),
    {
      id: "reopen-tab",
      label: "Reopen Closed Tab",
      hint: "⌘⇧T",
      run: reopenTab,
    },
    {
      id: "zoom-pane",
      label: "Toggle Maximize Pane",
      hint: "⌘⏎",
      run: toggleZoom,
    },
    {
      id: "jump-prev",
      label: "Jump to Previous Command",
      hint: "⌘↑",
      run: () =>
        handles.current.get(focusedPaneRef.current)?.jumpPrompt(-1),
    },
    {
      id: "jump-next",
      label: "Jump to Next Command",
      hint: "⌘↓",
      run: () =>
        handles.current.get(focusedPaneRef.current)?.jumpPrompt(1),
    },
    {
      id: "clear",
      label: "Clear Terminal",
      hint: "⌘K",
      run: clearFocused,
    },
    {
      id: "font-in",
      label: "Increase Font Size",
      hint: "⌘+",
      run: () => zoomFont(1),
    },
    {
      id: "font-out",
      label: "Decrease Font Size",
      hint: "⌘-",
      run: () => zoomFont(-1),
    },
    {
      id: "font-reset",
      label: "Reset Font Size",
      hint: "⌘0",
      run: () => zoomFont(0),
    },
    {
      id: "gotofile",
      label: "Go to File…",
      hint: "⌘P",
      run: () => setQuickOpen(true),
    },
    {
      id: "toggle-sidebar",
      label: "Toggle File Browser",
      hint: "⌘B",
      run: () => setSidebarOpen((v) => !v),
    },
    {
      id: "zen",
      label: "Toggle Zen Mode",
      hint: "⌘.",
      run: () => setZen((v) => !v),
    },
    {
      id: "search",
      label: "Search Scrollback…",
      hint: "⌘F",
      run: () => {
        setSearch((s) => ({ ...s, open: true }));
        requestAnimationFrame(() => searchInputRef.current?.focus());
      },
    },
    {
      id: "rename-tab",
      label: "Rename Tab…",
      run: () => setEditingTab(activeTab),
    },
    {
      id: "reveal-root",
      label: "Reveal Folder in Finder",
      run: () => root && revealInFinder(root),
    },
    {
      id: "ai-toggle",
      label: "Toggle AI Assistant",
      hint: "⌘I",
      run: () => setShowAi((v) => !v),
    },
    {
      id: "ai-settings",
      label: "AI Settings…",
      run: () => setShowAiSettings(true),
    },
    {
      id: "toggle-translucent",
      label: settings.translucent
        ? "Disable Window Translucency"
        : "Enable Window Translucency",
      run: () => setSettings((s) => ({ ...s, translucent: !s.translucent })),
    },
    {
      id: "toggle-hidden",
      label: settings.showHidden
        ? "Hide Hidden Files"
        : "Show Hidden Files",
      run: () => setSettings((s) => ({ ...s, showHidden: !s.showHidden })),
    },
    {
      id: "check-update",
      label: "Check for Updates…",
      run: checkForUpdate,
    },
    {
      id: "settings",
      label: "Open Settings…",
      run: () => setShowSettings(true),
    },
    ...settings.snippets.map((sn) => ({
      id: `snippet-${sn.id}`,
      label: `Run: ${sn.name}`,
      hint: sn.command.length > 32 ? sn.command.slice(0, 32) + "…" : sn.command,
      run: () => activeHandle()?.sendText(sn.command + "\n"),
    })),
    // Built-in + user-defined themes (kept in sync via themeOptions).
    ...themeOptions(settings).map((o) => ({
      id: `theme-${o.id}`,
      label: `Theme: ${o.label}`,
      run: () => setSettings((s) => ({ ...s, theme: o.id })),
    })),
  ];

  if (home === null || root === null) {
    return <div className="loading">Loading…</div>;
  }

  return (
    <div className={`app${zen ? " zen" : ""}`}>
      {zen && (
        <button
          className="zen-exit"
          title="Exit zen mode (⌘.)"
          onClick={() => setZen(false)}
        >
          <IconZenExit size={14} />
          <span>Exit Zen</span>
        </button>
      )}
      <div className="topbar">
        <div className="tabs">
          <div className="ws-strip">
            {workspaces.length > 1 && (
              <div className="ws-scroll" ref={wsScrollRef}>
                {workspaces.map((w) =>
                  editingWs === w.id ? (
                    <input
                      key={w.id}
                      className="ws-edit"
                      autoFocus
                      defaultValue={w.name}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        renameWorkspace(w.id, e.target.value);
                        setEditingWs(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          renameWorkspace(w.id, e.currentTarget.value);
                          setEditingWs(null);
                        } else if (e.key === "Escape") {
                          setEditingWs(null);
                        }
                      }}
                    />
                  ) : (
                    <div
                      key={w.id}
                      className={`ws-pill ${w.id === activeWs ? "active" : ""}`}
                      title="Switch workspace (double-click to rename) — ⌘⇧←/→"
                      onClick={() => switchWs(w.id)}
                      onDoubleClick={() => setEditingWs(w.id)}
                    >
                      <span>{w.name}</span>
                      <button
                        className="ws-close"
                        title="Delete workspace (closes its terminals)"
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteWorkspace(w.id);
                        }}
                      >
                        <IconClose size={11} />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
            <button
              className="ws-new"
              title="New workspace"
              onClick={addWorkspace}
            >
              <IconPlus size={12} />
              <span>Workspace</span>
            </button>
          </div>
          <div className="tab-scroll" ref={tabScrollRef}>
            {tabs
              .filter((t) => t.ws === activeWs)
              .map((t, i) => (
                <div
                  key={t.id}
                  className={`tab ${t.id === activeTab ? "active" : ""}`}
                  draggable={editingTab !== t.id}
                  onClick={() => selectTab(t.id)}
                  onDoubleClick={() => setEditingTab(t.id)}
                  onDragStart={() => (dragTab.current = t.id)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragTab.current != null)
                      reorderTabs(dragTab.current, t.id);
                    dragTab.current = null;
                  }}
                >
                  {editingTab === t.id ? (
                    <input
                      className="tab-edit"
                      autoFocus
                      defaultValue={t.title ?? `Terminal ${i + 1}`}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={(e) => {
                        renameTab(t.id, e.target.value);
                        setEditingTab(null);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          renameTab(t.id, e.currentTarget.value);
                          setEditingTab(null);
                        } else if (e.key === "Escape") {
                          setEditingTab(null);
                        }
                      }}
                    />
                  ) : (
                    <span>
                      {activity.has(t.id) && t.id !== activeTab && (
                        <span className="tab-dot" title="New output" />
                      )}
                      {t.title ?? `Terminal ${i + 1}`}
                    </span>
                  )}
                  <button
                    className="tab-close"
                    title="Close tab"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t.id);
                    }}
                  >
                    <IconClose size={13} />
                  </button>
                </div>
              ))}
          </div>
          <button
            className="tab-new icon-btn"
            title="New tab (⌘T)"
            onClick={() => newTab()}
          >
            <IconPlus size={15} />
          </button>
          <div className="newtab-menu-wrap">
            <button
              className="icon-btn newtab-caret"
              title="New tab with profile or agent…"
              onClick={() => setNewTabMenu((v) => !v)}
            >
              <IconChevronDown size={13} />
            </button>
            {newTabMenu && (
              <>
                <div
                  className="menu-backdrop"
                  onClick={() => setNewTabMenu(false)}
                />
                <div className="newtab-menu">
                  <button
                    onClick={() => {
                      setNewTabMenu(false);
                      newTab(null);
                    }}
                  >
                    Default shell
                  </button>
                  {settings.profiles.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => {
                        setNewTabMenu(false);
                        newTab(p.id);
                      }}
                    >
                      {p.name}
                    </button>
                  ))}
                  <div className="newtab-menu-sep" />
                  {AGENTS.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setNewTabMenu(false);
                        void launchAgent(a);
                      }}
                    >
                      {a.name} session
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
        <div className="topbar-actions">
          <button
            className={`icon-btn${sidebarOpen ? " active" : ""}`}
            title="Toggle file browser (⌘B)"
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <IconSidebar size={16} />
          </button>
          <ActivityMonitor />
          <button
            className={`icon-btn${broadcast ? " active" : ""}`}
            title={
              broadcast
                ? "Broadcast input: ON (typing goes to all panes in this tab)"
                : "Broadcast input to all panes in this tab"
            }
            onClick={() => setBroadcast((v) => !v)}
          >
            <IconBroadcast size={16} />
          </button>
          <button
            className="icon-btn"
            title="Split pane right (⌘D)"
            onClick={() => splitFocused("row")}
          >
            <IconSplitRight size={16} />
          </button>
          <button
            className="icon-btn"
            title="Split pane down (⌘⇧D)"
            onClick={() => splitFocused("col")}
          >
            <IconSplitDown size={16} />
          </button>
          <button
            className="icon-btn"
            title="Zen mode (⌘.)"
            onClick={() => setZen(true)}
          >
            <IconZen size={16} />
          </button>
          <button
            className="icon-btn"
            title="Command palette (⌘⇧P)"
            onClick={() => setPalette(true)}
          >
            <IconPalette size={16} />
          </button>
          <button
            className="icon-btn"
            title="Search (⌘F)"
            onClick={() => {
              setSearch((s) => ({ ...s, open: true }));
              requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
          >
            <IconSearch size={16} />
          </button>
          <button
            className={`icon-btn${showAi ? " active" : ""}`}
            title="AI Assistant (⌘I)"
            onClick={() => setShowAi((v) => !v)}
          >
            <IconSparkle size={16} />
          </button>
          <button className="icon-btn" title="Settings" onClick={() => setShowSettings(true)}>
            <IconSettings size={16} />
          </button>
        </div>
      </div>

      <div className="body">
        {sidebarOpen && (
          <>
            <aside className="sidebar" style={{ width: leftWidth }}>
              <FileBrowser
                rootPath={root}
                onNavigateRoot={navigateRoot}
                onOpenFile={openFile}
                onDiff={openDiff}
                refreshKey={gitNonce}
                onCdHere={(p) =>
                  activeHandle()?.sendText(`cd ${shellQuote(p)}\n`)
                }
                onReveal={(p) => revealInFinder(p)}
                onNewTerminalHere={newTabAt}
                showHidden={settings.showHidden}
                bookmarks={settings.bookmarks}
                onToggleBookmark={(p) =>
                  setSettings((s) => ({
                    ...s,
                    bookmarks: s.bookmarks.includes(p)
                      ? s.bookmarks.filter((b) => b !== p)
                      : [...s.bookmarks, p],
                  }))
                }
              />
            </aside>
            <div
              className="divider"
              onMouseDown={() => {
                dragging.current = true;
                document.body.style.cursor = "col-resize";
              }}
            />
          </>
        )}
        <main className="content">
          {openItems.length > 0 && (
            <EditorArea
              ref={editorRef}
              items={openItems}
              activeKey={activeKey}
              settings={settings}
              onActivate={setActiveKey}
              onClose={closeItem}
              onReveal={(p) => {
                const d = p.slice(0, p.lastIndexOf("/")) || "/";
                navigateRoot(d);
                setSidebarOpen(true);
              }}
              onDiff={openDiff}
              onSaved={() => setGitNonce((n) => n + 1)}
            />
          )}
          {search.open && (
            <div className="search-bar">
              <input
                ref={searchInputRef}
                placeholder="Search scrollback…"
                value={search.term}
                onChange={(e) => {
                  const term = e.target.value;
                  setSearch((s) => ({ ...s, term }));
                  if (term) activeHandle()?.findNext(term);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    if (e.shiftKey) activeHandle()?.findPrevious(search.term);
                    else activeHandle()?.findNext(search.term);
                  } else if (e.key === "Escape") {
                    closeSearch();
                  }
                }}
              />
              <button
                className="icon-btn"
                title="Previous match (⇧⏎)"
                onClick={() => activeHandle()?.findPrevious(search.term)}
              >
                <IconChevronUp size={15} />
              </button>
              <button
                className="icon-btn"
                title="Next match (⏎)"
                onClick={() => activeHandle()?.findNext(search.term)}
              >
                <IconChevronDown size={15} />
              </button>
              <button className="icon-btn" title="Close (Esc)" onClick={closeSearch}>
                <IconClose size={15} />
              </button>
            </div>
          )}
          <div className="terminals">
            {tabs.map((t) => {
              const { leaves, dividers } = computeLayout(t.layout);
              const tabActive = t.id === activeTab;
              return (
                <div
                  key={t.id}
                  className="terminal-wrap"
                  style={{ display: tabActive ? "block" : "none" }}
                >
                  {leaves.map(({ id, rect }) => {
                    // When a pane is zoomed in this tab, it fills the wrap and
                    // the others are hidden (but kept mounted so they don't
                    // respawn). Dividers are hidden too.
                    const zoom = tabActive && zoomedPane != null;
                    const isZoomed = zoom && id === zoomedPane;
                    const r = isZoomed ? { x: 0, y: 0, w: 1, h: 1 } : rect;
                    const hidden = zoom && !isZoomed;
                    return (
                      <div
                        key={id}
                        className={`pane${
                          leaves.length > 1 &&
                          tabActive &&
                          !zoom &&
                          id === focusedPane
                            ? " focused"
                            : ""
                        }`}
                        style={{
                          left: `${r.x * 100}%`,
                          top: `${r.y * 100}%`,
                          width: `${r.w * 100}%`,
                          height: `${r.h * 100}%`,
                          display: hidden ? "none" : "block",
                        }}
                      >
                        <TerminalPane
                          ref={getRefCb(id)}
                          cwd={paneCwd.current.get(id) ?? home}
                          profile={t.spawn ?? profileSpawn(profileById(t.profileId))}
                          visible={tabActive && !hidden}
                          focused={tabActive && id === focusedPane}
                          settings={settings}
                          onCwdChange={(c) => {
                            paneCwd.current.set(id, c);
                            if (id === focusedPane) setRoot(c);
                          }}
                          onFocusRequest={() => setFocusedPane(id)}
                          onOpenPath={openFile}
                          onResize={(rows, cols) => {
                            if (id === focusedPane) setDims({ rows, cols });
                          }}
                          onInput={(data) => {
                            if (!broadcast || id !== focusedPane) return;
                            for (const lid of leafIds(t.layout)) {
                              if (lid !== id)
                                handles.current.get(lid)?.write(data);
                            }
                          }}
                          onActivity={() => {
                            if (t.id === activeTab) return;
                            setActivity((prev) => {
                              if (prev.has(t.id)) return prev;
                              const next = new Set(prev);
                              next.add(t.id);
                              return next;
                            });
                          }}
                          onMeta={handleMeta}
                          canClose={leaves.length > 1}
                          onClose={() => closePane(id)}
                          onExit={(code) => {
                            // Clean exit (e.g. `exit`, SSH logout) closes the
                            // pane/tab; abnormal exits stay open (TerminalPane
                            // shows the code) so the error is readable.
                            if (code === 0) closePane(id);
                          }}
                          persistKey={id}
                        />
                      </div>
                    );
                  })}
                  {!(tabActive && zoomedPane != null) &&
                    dividers.map((d) => {
                    const isRow = d.dir === "row";
                    const startDrag = (e: React.MouseEvent) => {
                      e.preventDefault();
                      const wrap = e.currentTarget.parentElement;
                      if (!wrap) return;
                      const move = (ev: MouseEvent) => {
                        const r = wrap.getBoundingClientRect();
                        const frac = isRow
                          ? (ev.clientX - (r.left + d.region.x * r.width)) /
                            (d.region.w * r.width)
                          : (ev.clientY - (r.top + d.region.y * r.height)) /
                            (d.region.h * r.height);
                        applyRatio(d.sid, Math.min(0.9, Math.max(0.1, frac)));
                      };
                      const up = () => {
                        window.removeEventListener("mousemove", move);
                        window.removeEventListener("mouseup", up);
                        document.body.style.cursor = "";
                      };
                      window.addEventListener("mousemove", move);
                      window.addEventListener("mouseup", up);
                      document.body.style.cursor = isRow
                        ? "col-resize"
                        : "row-resize";
                    };
                    const style = isRow
                      ? {
                          left: `${(d.region.x + d.region.w * d.ratio) * 100}%`,
                          top: `${d.region.y * 100}%`,
                          height: `${d.region.h * 100}%`,
                        }
                      : {
                          top: `${(d.region.y + d.region.h * d.ratio) * 100}%`,
                          left: `${d.region.x * 100}%`,
                          width: `${d.region.w * 100}%`,
                        };
                    return (
                      <div
                        key={d.sid}
                        className={isRow ? "pane-divider-v" : "pane-divider-h"}
                        style={style}
                        onMouseDown={startDrag}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </main>
        {/* Kept mounted (hidden when closed) so an in-flight agent run and its
            transcript survive toggling the panel. Wrapped in an error boundary
            so an AI-panel render error can never blank the terminal. */}
        <ErrorBoundary label="The AI assistant">
          <AIPanel
            config={aiConfig}
            cwd={root}
            readTerminal={(lines) =>
              handles.current.get(focusedPane)?.getBuffer(lines) ?? null
            }
            hidden={!showAi || zen}
            onClose={() => setShowAi(false)}
            onOpenSettings={() => setShowAiSettings(true)}
          />
        </ErrorBoundary>
      </div>

      <StatusBar
        cwd={root}
        profileName={profileById(tabs.find((t) => t.id === activeTab)?.profileId)?.name ?? null}
        rows={dims?.rows ?? null}
        cols={dims?.cols ?? null}
      />

      {showAiSettings && (
        <AISettings
          config={aiConfig}
          onChange={setAiConfig}
          onClose={() => setShowAiSettings(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      {quickOpen && (
        <QuickOpen
          root={root}
          onOpen={openFile}
          onClose={() => setQuickOpen(false)}
        />
      )}

      {palette && (
        <CommandPalette
          commands={buildCommands()}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  );
}
