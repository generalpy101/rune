/** Meta commands — app actions reachable from *inside* the terminal.
 *
 *  A small shell function (`rt`) emits a custom OSC escape sequence
 *  (`ESC ] 7000 ; <payload> BEL`) which xterm intercepts (see TerminalPane's
 *  OSC handler) and routes here. This is the same robust mechanism real
 *  terminals use for shell integration: the shell runs an ordinary command, so
 *  it never interferes with full-screen programs (vim, htop, less).
 *
 *  `runMeta` returns a string to print back into the terminal (help/listings),
 *  or nothing for actions that just change app state. */

/** The OSC identifier the `rt` shell function targets. */
export const META_OSC = 7000;

/** Shell function injected (when shell integration is on) so `rt …` works.
 *  POSIX syntax — covers zsh (macOS default), bash and sh. Fish users can add
 *  an equivalent `function rt; printf '\\033]7000;%s\\007' "$argv"; end`. */
export const RT_FUNCTION = `rt() { printf '\\033]${META_OSC};%s\\007' "$*"; }`;

/** App actions the dispatcher can invoke. Implemented in App.tsx against the
 *  focused pane / current settings. */
export interface MetaContext {
  /** Run a saved snippet by name (case-insensitive, prefix-matched). */
  runSnippet: (query: string) => boolean;
  listSnippets: () => { name: string; command: string }[];
  /** Connect to a saved SSH host by name (case-insensitive, prefix-matched). */
  connectSsh: (query: string) => boolean;
  listSshHosts: () => { name: string; target: string }[];
  /** Switch theme by id or label. Returns false if unknown. */
  setTheme: (idOrLabel: string) => boolean;
  themeNames: () => { id: string; label: string }[];
  split: (dir: "row" | "col") => void;
  /** Close the focused pane (or the tab when it's the last pane). */
  closePane: () => void;
  newTab: () => void;
  toggleSidebar: () => void;
  toggleAi: () => void;
  clearTerminal: () => void;
}

const HELP = [
  "Rune commands (rt <command>):",
  "  rt snippet <name>   run a saved snippet",
  "  rt snippets         list saved snippets",
  "  rt ssh <name>       connect to a saved SSH host",
  "  rt hosts            list saved SSH hosts",
  "  rt theme [name]     switch theme (no name = list)",
  "  rt split [right|down]  split the focused pane",
  "  rt close            close the focused pane",
  "  rt tab              open a new tab",
  "  rt sidebar          toggle the file browser",
  "  rt ai               toggle the AI assistant",
  "  rt clear            clear this terminal",
  "  rt help             show this help",
].join("\n");

/** Dispatch a meta-command payload. Returns text to echo, or void. */
export function runMeta(payload: string, ctx: MetaContext): string | void {
  const parts = payload.trim().split(/\s+/);
  const cmd = (parts.shift() ?? "").toLowerCase();
  const rest = parts.join(" ");

  switch (cmd) {
    case "":
    case "help":
    case "-h":
    case "--help":
      return HELP;

    case "snippet":
    case "run": {
      if (!rest) return "usage: rt snippet <name>";
      return ctx.runSnippet(rest) ? undefined : `snippet not found: ${rest}`;
    }

    case "snippets":
    case "list": {
      const list = ctx.listSnippets();
      if (!list.length) return "No snippets saved (add some in Settings → Snippets).";
      return (
        "Snippets:\n" +
        list.map((s) => `  ${s.name}  —  ${s.command}`).join("\n")
      );
    }

    case "ssh":
    case "connect": {
      if (!rest) return "usage: rt ssh <host name>";
      return ctx.connectSsh(rest) ? undefined : `ssh host not found: ${rest}`;
    }

    case "hosts":
    case "ssh-list": {
      const list = ctx.listSshHosts();
      if (!list.length)
        return "No SSH hosts saved (add some in Settings → SSH).";
      return (
        "SSH hosts:\n" +
        list.map((h) => `  ${h.name}  —  ${h.target}`).join("\n")
      );
    }

    case "theme": {
      if (!rest)
        return "Themes: " + ctx.themeNames().map((t) => t.id).join(", ");
      return ctx.setTheme(rest) ? undefined : `theme not found: ${rest}`;
    }

    case "split": {
      const d = (parts[0] ?? rest ?? "right").toLowerCase();
      ctx.split(d === "down" || d === "col" || d === "v" ? "col" : "row");
      return;
    }

    case "close":
      ctx.closePane();
      return;

    case "tab":
      ctx.newTab();
      return;

    case "sidebar":
      ctx.toggleSidebar();
      return;

    case "ai":
      ctx.toggleAi();
      return;

    case "clear":
    case "cls":
      ctx.clearTerminal();
      return;

    default:
      return `unknown command: ${cmd}  (try 'rt help')`;
  }
}
