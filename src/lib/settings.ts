import type { ITheme } from "@xterm/xterm";
import type { SpawnProfile } from "./pty";

export interface Settings {
  fontSize: number;
  fontFamily: string;
  /** A built-in ThemeName or the id of a user-defined theme in `customThemes`. */
  theme: string;
  cursorBlink: boolean;
  /** User-defined themes, addressable by id. Edited/imported from settings. */
  customThemes: CustomThemeDef[];
  /** Saved shell profiles (custom shell + args + env + startup dir). */
  profiles: Profile[];
  /** Profile used for new terminals; `null` = the OS default login shell. */
  defaultProfileId: string | null;
  /** Copy text to the clipboard automatically when selected in the terminal. */
  copyOnSelect: boolean;
  /** Paste the clipboard on middle-click in the terminal. */
  middleClickPaste: boolean;
  /** Ask for confirmation before closing a tab/pane with a running command. */
  confirmCloseRunning: boolean;
  /** Post a desktop notification when a long command finishes while unfocused. */
  notifyOnDone: boolean;
  /** Use a translucent (vibrancy) window background on macOS. */
  translucent: boolean;
  /** Show dotfiles / hidden entries in the file browser. */
  showHidden: boolean;
  /** Bookmarked folders for quick navigation in the file browser. */
  bookmarks: string[];
  /** Saved command snippets, runnable from the command palette. */
  snippets: Snippet[];
  /** Saved SSH hosts, connectable in a new tab. */
  sshHosts: SshHost[];
  /** Inject the `rt` shell function so meta commands work from the terminal. */
  shellIntegration: boolean;
  /** Auto-save the file editor after edits stop (debounced). */
  autosave: boolean;
  /** Debounce delay (ms) before an autosave fires. */
  autosaveDelayMs: number;
  /** On save, trim trailing whitespace and ensure a single final newline. */
  tidyOnSave: boolean;
}

/** A saved command the user can re-run from the palette. */
export interface Snippet {
  id: string;
  name: string;
  command: string;
}

/** A saved SSH connection. Connecting opens a tab whose terminal runs the
 *  system `ssh` client with these settings — no extra backend needed. */
export interface SshHost {
  id: string;
  /** Display label (tab title + palette entry). */
  name: string;
  /** Hostname or IP. */
  host: string;
  /** Login user (omitted = ssh default / from ~/.ssh/config). */
  user?: string;
  /** Port (omitted = 22). */
  port?: number;
  /** Path to a private key passed via `-i`. */
  identityFile?: string;
  /** Extra raw `ssh` arguments, space-separated (e.g. `-A -J jump`). */
  extraArgs?: string;
  /** Theme to switch to on connect — a visual cue you're on a remote box. */
  themeId?: string;
}

/** Build the backend SpawnProfile that launches `ssh` for a saved host. */
export function sshSpawn(h: SshHost): SpawnProfile {
  const args: string[] = [];
  if (h.port) args.push("-p", String(h.port));
  if (h.identityFile && h.identityFile.trim())
    args.push("-i", h.identityFile.trim());
  if (h.extraArgs && h.extraArgs.trim())
    args.push(...h.extraArgs.trim().split(/\s+/));
  const target = h.host.trim();
  args.push(h.user && h.user.trim() ? `${h.user.trim()}@${target}` : target);
  return { shell: "ssh", args };
}

export type ThemeName = "mocha" | "latte" | "dracula" | "tokyo" | "nord";

/** A user-defined shell configuration a terminal/tab can launch with. */
export interface Profile {
  id: string;
  name: string;
  /** Program to launch (path or name on PATH). Empty = OS default login shell. */
  shell?: string;
  /** Arguments passed to the shell. */
  args?: string[];
  /** Extra environment variables for sessions started with this profile. */
  env?: Record<string, string>;
  /** Startup working directory. Empty = inherit (last cwd / home). */
  cwd?: string;
}

/** Chrome (app UI) palette. Drives CSS custom properties so the whole app —
 *  not just the xterm canvas — re-themes when the theme changes. */
export interface UIColors {
  bg: string; // app backdrop (darkest / behind panels)
  panel: string; // primary surface (content, terminal frame)
  panel2: string; // chrome surface (topbar, sidebar, AI panel)
  panel3: string; // raised / hover surface
  border: string;
  text: string;
  muted: string;
  accent: string;
  accentFg: string; // text/icon shown on top of accent
  danger: string;
  success: string;
  warning: string;
  purple: string; // A2A / background-server accent
}

export interface ThemeDef {
  label: string;
  dark: boolean;
  terminal: ITheme;
  ui: UIColors;
}

/** A user-defined theme. Same shape as a built-in plus a stable id. */
export interface CustomThemeDef extends ThemeDef {
  id: string;
}

export const THEMES: Record<ThemeName, ThemeDef> = {
  mocha: {
    label: "Mocha",
    dark: true,
    terminal: {
      background: "#1e1e2e",
      foreground: "#cdd6f4",
      cursor: "#f5e0dc",
      selectionBackground: "#585b70",
      black: "#45475a",
      red: "#f38ba8",
      green: "#a6e3a1",
      yellow: "#f9e2af",
      blue: "#89b4fa",
      magenta: "#f5c2e7",
      cyan: "#94e2d5",
      white: "#bac2de",
    },
    ui: {
      bg: "#11111b",
      panel: "#1e1e2e",
      panel2: "#181825",
      panel3: "#313244",
      border: "#313244",
      text: "#cdd6f4",
      muted: "#9399b2",
      accent: "#89b4fa",
      accentFg: "#11111b",
      danger: "#f38ba8",
      success: "#a6e3a1",
      warning: "#f9e2af",
      purple: "#cba6f7",
    },
  },
  latte: {
    label: "Latte",
    dark: false,
    terminal: {
      background: "#eff1f5",
      foreground: "#4c4f69",
      cursor: "#dc8a78",
      selectionBackground: "#acb0be",
      black: "#5c5f77",
      red: "#d20f39",
      green: "#40a02b",
      yellow: "#df8e1d",
      blue: "#1e66f5",
      magenta: "#ea76cb",
      cyan: "#179299",
      white: "#acb0be",
    },
    ui: {
      bg: "#dce0e8",
      panel: "#eff1f5",
      panel2: "#e6e9ef",
      panel3: "#ccd0da",
      border: "#bcc0cc",
      text: "#4c4f69",
      muted: "#6c6f85",
      accent: "#1e66f5",
      accentFg: "#eff1f5",
      danger: "#d20f39",
      success: "#40a02b",
      warning: "#df8e1d",
      purple: "#8839ef",
    },
  },
  dracula: {
    label: "Dracula",
    dark: true,
    terminal: {
      background: "#282a36",
      foreground: "#f8f8f2",
      cursor: "#f8f8f2",
      selectionBackground: "#44475a",
      black: "#21222c",
      red: "#ff5555",
      green: "#50fa7b",
      yellow: "#f1fa8c",
      blue: "#bd93f9",
      magenta: "#ff79c6",
      cyan: "#8be9fd",
      white: "#f8f8f2",
    },
    ui: {
      bg: "#1a1b23",
      panel: "#282a36",
      panel2: "#21222c",
      panel3: "#44475a",
      border: "#44475a",
      text: "#f8f8f2",
      muted: "#6272a4",
      accent: "#bd93f9",
      accentFg: "#21222c",
      danger: "#ff5555",
      success: "#50fa7b",
      warning: "#f1fa8c",
      purple: "#ff79c6",
    },
  },
  tokyo: {
    label: "Tokyo Night",
    dark: true,
    terminal: {
      background: "#1a1b26",
      foreground: "#c0caf5",
      cursor: "#c0caf5",
      selectionBackground: "#33467c",
      black: "#15161e",
      red: "#f7768e",
      green: "#9ece6a",
      yellow: "#e0af68",
      blue: "#7aa2f7",
      magenta: "#bb9af7",
      cyan: "#7dcfff",
      white: "#a9b1d6",
    },
    ui: {
      bg: "#16161e",
      panel: "#1a1b26",
      panel2: "#13131a",
      panel3: "#292e42",
      border: "#2a2e3f",
      text: "#c0caf5",
      muted: "#7e84a3",
      accent: "#7aa2f7",
      accentFg: "#16161e",
      danger: "#f7768e",
      success: "#9ece6a",
      warning: "#e0af68",
      purple: "#bb9af7",
    },
  },
  nord: {
    label: "Nord",
    dark: true,
    terminal: {
      background: "#2e3440",
      foreground: "#d8dee9",
      cursor: "#d8dee9",
      selectionBackground: "#434c5e",
      black: "#3b4252",
      red: "#bf616a",
      green: "#a3be8c",
      yellow: "#ebcb8b",
      blue: "#81a1c1",
      magenta: "#b48ead",
      cyan: "#88c0d0",
      white: "#e5e9f0",
    },
    ui: {
      bg: "#272c36",
      panel: "#2e3440",
      panel2: "#272c36",
      panel3: "#3b4252",
      border: "#3b4252",
      text: "#d8dee9",
      muted: "#7b8493",
      accent: "#88c0d0",
      accentFg: "#272c36",
      danger: "#bf616a",
      success: "#a3be8c",
      warning: "#ebcb8b",
      purple: "#b48ead",
    },
  },
};

/** Resolve the active ThemeDef from settings: a built-in by name, a custom theme
 *  by id, or Mocha as a safe fallback. */
export function resolveTheme(settings: Settings): ThemeDef {
  if (settings.theme in THEMES) return THEMES[settings.theme as ThemeName];
  const custom = settings.customThemes?.find((t) => t.id === settings.theme);
  return custom ?? THEMES.mocha;
}

/** Built-in + custom themes as `{ id, label }` options for a theme picker. */
export function themeOptions(
  settings: Settings,
): { id: string; label: string }[] {
  const builtins = (Object.keys(THEMES) as ThemeName[]).map((id) => ({
    id,
    label: THEMES[id].label,
  }));
  const custom = (settings.customThemes ?? []).map((t) => ({
    id: t.id,
    label: `${t.label} (custom)`,
  }));
  return [...builtins, ...custom];
}

/** Push a theme's chrome palette into CSS custom properties on :root, so the
 *  entire app (tabs, sidebar, AI panel, modals) re-themes — not just xterm. */
export function applyTheme(settings: Settings): void {
  const def = resolveTheme(settings);
  const ui = def.ui;
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);
  set("--bg", ui.bg);
  set("--panel", ui.panel);
  set("--panel-2", ui.panel2);
  set("--panel-3", ui.panel3);
  set("--border", ui.border);
  set("--text", ui.text);
  set("--fg", ui.text);
  set("--muted", ui.muted);
  set("--accent", ui.accent);
  set("--accent-fg", ui.accentFg);
  set("--danger", ui.danger);
  set("--success", ui.success);
  set("--warning", ui.warning);
  set("--purple", ui.purple);
  root.style.colorScheme = def.dark === false ? "light" : "dark";
}

/** Map a saved Profile to the backend `SpawnProfile`, or `null` when it carries
 *  no overrides (so the OS default shell is used). */
export function profileSpawn(p?: Profile | null): SpawnProfile | null {
  if (!p) return null;
  const sp: SpawnProfile = {};
  if (p.shell && p.shell.trim()) sp.shell = p.shell.trim();
  if (p.args && p.args.length) sp.args = p.args;
  if (p.env && Object.keys(p.env).length) sp.env = p.env;
  return Object.keys(sp).length ? sp : null;
}

export const DEFAULT_SETTINGS: Settings = {
  fontSize: 13,
  fontFamily: 'Menlo, "JetBrains Mono", "SF Mono", Consolas, monospace',
  theme: "mocha",
  cursorBlink: true,
  customThemes: [],
  profiles: [],
  defaultProfileId: null,
  copyOnSelect: false,
  middleClickPaste: false,
  confirmCloseRunning: true,
  notifyOnDone: false,
  translucent: false,
  showHidden: false,
  bookmarks: [],
  snippets: [],
  sshHosts: [],
  shellIntegration: true,
  autosave: false,
  autosaveDelayMs: 1000,
  tidyOnSave: false,
};

const KEY = "rustterm.settings";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* ignore corrupt settings */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* ignore quota errors */
  }
}
