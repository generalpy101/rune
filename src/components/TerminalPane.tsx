import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Terminal, type IMarker, type IDecoration } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  spawnPty,
  attachPty,
  writePty,
  resizePty,
  killPty,
  ptyCwd,
  ptyBusy,
  type SpawnProfile,
} from "../lib/pty";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { notify } from "../lib/fs";
import { resolveTheme, type Settings } from "../lib/settings";
import { META_OSC } from "../lib/meta";
import { ContextMenu } from "./ContextMenu";

/** Tokens in terminal output that look like file paths: either something with
 *  slashes (absolute or relative) or a bare `name.ext` with a known extension. */
const PATH_RE =
  /(?:~|\.{1,2})?(?:\/[\w.@+-]+)+|\b[\w.@+-]+\.(?:rs|ts|tsx|js|jsx|mjs|cjs|json|md|toml|yaml|yml|css|scss|html|py|go|c|h|cpp|java|rb|php|sh|txt|lock|env|sql|vue|svelte)\b/g;

/** Resolve a token clicked in the terminal to an absolute path, using the
 *  shell's last-known cwd for relative tokens. Returns null when unresolvable. */
function resolvePath(token: string, cwd: string | null): string | null {
  let t = token.trim();
  if (!t) return null;
  if (t.startsWith("/")) return t;
  if (t.startsWith("~")) return null; // ~ expansion not available in the renderer
  if (!cwd) return null;
  if (t.startsWith("./")) t = t.slice(2);
  return `${cwd.replace(/\/$/, "")}/${t}`;
}

export interface TerminalHandle {
  /** Write text into the shell (e.g. a `cd` command), then focus. */
  sendText: (text: string) => void;
  /** Write raw bytes into the PTY without focusing — used for broadcast input. */
  write: (text: string) => void;
  focus: () => void;
  refit: () => void;
  clear: () => void;
  findNext: (term: string) => void;
  findPrevious: (term: string) => void;
  clearSearch: () => void;
  /** Snapshot of the terminal's visible buffer + scrollback as plain text
   *  (last `maxLines` non-empty-trimmed rows), for AI agent context. */
  getBuffer: (maxLines?: number) => string;
  /** Last-polled "a foreground command is running" state (for confirm-close). */
  isBusy: () => boolean;
  /** Scroll to the previous (-1) or next (1) shell prompt, using OSC 133
   *  command-block markers. No-op when shell integration isn't emitting them. */
  jumpPrompt: (dir: 1 | -1) => void;
}

/** One shell command's lifecycle, tracked from OSC 133 markers. `marker` pins
 *  the prompt line (so it follows scrollback and disposes when trimmed); the
 *  decoration draws a status bar in the left margin. */
interface CmdBlock {
  marker: IMarker;
  decoration: IDecoration;
  el: HTMLElement | null;
  running: boolean;
  exitCode: number | null;
  /** Monotonic creation index — used for stable alternating band tint. */
  idx: number;
  /** Transient highlight after a ⌘↑/⌘↓ jump, so the user sees where they landed. */
  flash: boolean;
}

interface Props {
  cwd: string | null;
  /** Shell/args/env overrides from the tab's profile. Null = default shell. */
  profile?: SpawnProfile | null;
  /** The pane's tab is the active one (so it's on-screen). Drives refit. */
  visible: boolean;
  /** This pane is the focused one within its tab. Drives focus + cwd polling. */
  focused: boolean;
  settings: Settings;
  /** Reports the shell's working directory as the user `cd`s around. */
  onCwdChange?: (cwd: string) => void;
  /** Asks the parent to make this pane the focused one. */
  onFocusRequest?: () => void;
  /** Open a file path the user clicked in the terminal output. */
  onOpenPath?: (path: string) => void;
  /** Reports the terminal's grid size after a fit (rows × cols). */
  onResize?: (rows: number, cols: number) => void;
  /** Fires for every keystroke/data the user types — used for broadcast input. */
  onInput?: (data: string) => void;
  /** Fires when output arrives while this pane's tab is in the background. */
  onActivity?: () => void;
  /** Handle a meta command emitted from the shell (the `rt` function). Returns
   *  optional text to print back into the terminal. */
  onMeta?: (payload: string) => string | void;
  /** Close this pane. When set (and the tab has >1 pane) a close affordance
   *  is shown. */
  onClose?: () => void;
  /** Fires when the PTY's process exits. `code` is the shell's exit status.
   *  Lets the parent close the pane on a clean exit (e.g. `exit` / SSH logout). */
  onExit?: (code: number) => void;
  /** Whether a per-pane close affordance should be offered (tab has splits). */
  canClose?: boolean;
  /** Stable identity for this pane across re-mounts. When set, the live PTY is
   *  remembered in sessionStorage so a dev-server full reload reattaches to the
   *  still-running shell instead of spawning a fresh one. */
  persistKey?: string | number;
}

export const TerminalPane = forwardRef<TerminalHandle, Props>(
  (
    {
      cwd,
      profile,
      visible,
      focused,
      settings,
      onCwdChange,
      onFocusRequest,
      onOpenPath,
      onResize,
      onInput,
      onActivity,
      onMeta,
      onClose,
      onExit,
      canClose,
      persistKey,
    },
    ref,
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const termRef = useRef<Terminal | null>(null);
    const fitRef = useRef<FitAddon | null>(null);
    const searchRef = useRef<SearchAddon | null>(null);
    const ptyIdRef = useRef<number | null>(null);
    const mountedRef = useRef(false);
    const lastCwdRef = useRef<string | null>(null);
    const busyRef = useRef(false);
    const busySinceRef = useRef<number | null>(null);
    // OSC 133 command blocks (most-recent last) and the block awaiting C/D.
    const blocksRef = useRef<CmdBlock[]>([]);
    const currentBlockRef = useRef<CmdBlock | null>(null);
    // Lets jumpPrompt (component scope) trigger a re-layout of the blocks, whose
    // layout function lives inside the mount effect's closure.
    const layoutBlocksRef = useRef<(() => void) | null>(null);
    // The block our prompt-navigation cursor is currently on. Tracked as a
    // block reference (not an index, since blocks come and go) so ⌘↑/⌘↓ step
    // command-to-command regardless of scroll position. Cleared when a new
    // prompt appears so the next jump starts from the latest command.
    const jumpAtRef = useRef<CmdBlock | null>(null);
    const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

    // Briefly highlight a block (after a jump) then clear it.
    const flashBlock = (b: CmdBlock) => {
      b.flash = true;
      layoutBlocksRef.current?.();
      window.setTimeout(() => {
        b.flash = false;
        layoutBlocksRef.current?.();
      }, 700);
    };

    // Step the prompt-navigation cursor to the previous (-1) / next (1) command
    // block, scroll it into view and flash it. Independent of scroll position so
    // it works even when all output fits on one screen.
    const jumpPrompt = (dir: 1 | -1) => {
      const term = termRef.current;
      if (!term) return;
      const entries = blocksRef.current
        .map((b) => ({ b, line: b.marker.line }))
        .filter((e): e is { b: CmdBlock; line: number } => typeof e.line === "number")
        .sort((a, z) => a.line - z.line);
      if (!entries.length) return;
      // Where the cursor is now. If we haven't jumped yet (or that block is
      // gone), seed it from the topmost block currently in the viewport so the
      // first ⌘↑ goes up from what you're looking at and ⌘↓ goes down.
      let cur = entries.findIndex((e) => e.b === jumpAtRef.current);
      if (cur < 0) {
        const top = term.buffer.active.viewportY;
        cur = 0;
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].line <= top) cur = i;
          else break;
        }
      }
      const nextIdx = Math.max(0, Math.min(entries.length - 1, cur + dir));
      const target = entries[nextIdx];
      jumpAtRef.current = target.b;
      term.scrollToLine(target.line);
      flashBlock(target.b);
    };

    // Keep the latest callbacks/settings in refs so effects stay stable.
    const onCwdChangeRef = useRef(onCwdChange);
    onCwdChangeRef.current = onCwdChange;
    const onFocusRequestRef = useRef(onFocusRequest);
    onFocusRequestRef.current = onFocusRequest;
    const onOpenPathRef = useRef(onOpenPath);
    onOpenPathRef.current = onOpenPath;
    const onResizeRef = useRef(onResize);
    onResizeRef.current = onResize;
    const onInputRef = useRef(onInput);
    onInputRef.current = onInput;
    const onActivityRef = useRef(onActivity);
    onActivityRef.current = onActivity;
    const onMetaRef = useRef(onMeta);
    onMetaRef.current = onMeta;
    const onExitRef = useRef(onExit);
    onExitRef.current = onExit;
    const settingsRef = useRef(settings);
    settingsRef.current = settings;
    // Track visibility in a ref so the PTY data callback can detect background
    // output without re-subscribing.
    const visibleRef = useRef(visible);
    visibleRef.current = visible;

    const doFit = () => {
      // Skip while hidden (display:none → zero size). Fitting against a 0×0 box
      // collapses the grid to a tiny size; the stale WebGL canvas then gets
      // scaled up to fill the box when the tab is shown again — the "zoomed in"
      // flash. Bail out so the terminal keeps its last good size until visible.
      const box = containerRef.current;
      if (!box || box.offsetWidth === 0 || box.offsetHeight === 0) return;
      try {
        fitRef.current?.fit();
      } catch {
        return;
      }
      const term = termRef.current;
      if (term && ptyIdRef.current != null) {
        resizePty(ptyIdRef.current, term.rows, term.cols);
        onResizeRef.current?.(term.rows, term.cols);
      }
    };

    useImperativeHandle(ref, () => ({
      sendText: (text: string) => {
        if (ptyIdRef.current != null) writePty(ptyIdRef.current, text);
        termRef.current?.focus();
      },
      write: (text: string) => {
        if (ptyIdRef.current != null) writePty(ptyIdRef.current, text);
      },
      focus: () => termRef.current?.focus(),
      refit: doFit,
      clear: () => {
        termRef.current?.clear();
        termRef.current?.focus();
      },
      findNext: (t) => searchRef.current?.findNext(t),
      findPrevious: (t) => searchRef.current?.findPrevious(t),
      clearSearch: () => searchRef.current?.clearDecorations(),
      getBuffer: (maxLines = 200) => {
        const term = termRef.current;
        if (!term) return "";
        const buf = term.buffer.active;
        const total = buf.length;
        const start = Math.max(0, total - maxLines);
        const lines: string[] = [];
        for (let i = start; i < total; i++) {
          const line = buf.getLine(i);
          lines.push(line ? line.translateToString(true) : "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      },
      isBusy: () => busyRef.current,
      jumpPrompt,
    }));

    // Mount once: create the terminal and spawn its PTY.
    useEffect(() => {
      if (mountedRef.current || !containerRef.current) return;
      mountedRef.current = true;

      const term = new Terminal({
        fontFamily: settings.fontFamily,
        fontSize: settings.fontSize,
        cursorBlink: settings.cursorBlink,
        theme: resolveTheme(settings).terminal,
        allowProposedApi: true,
      });
      termRef.current = term;

      const fitAddon = new FitAddon();
      fitRef.current = fitAddon;
      const searchAddon = new SearchAddon();
      searchRef.current = searchAddon;
      term.loadAddon(fitAddon);
      term.loadAddon(searchAddon);
      term.loadAddon(new WebLinksAddon());
      term.open(containerRef.current);

      // Shell-integration channel: the `rt` shell function emits
      // `ESC ] META_OSC ; <payload> BEL`; route the payload to the app and
      // print any returned text back into this terminal as command output.
      term.parser.registerOscHandler(META_OSC, (payload) => {
        const out = onMetaRef.current?.(payload);
        if (typeof out === "string" && out.length) {
          term.write("\r\n" + out.replace(/\n/g, "\r\n") + "\r\n");
        }
        return true;
      });

      // OSC 133 command-block integration (shell emits these via our injected
      // hooks): A = prompt start, B = prompt end, C = command output start,
      // D[;code] = command done. Each command (prompt + its output) becomes a
      // Warp-style block: a faint full-width band behind the text, alternating
      // shade so consecutive commands are visually separated, with a colored
      // left edge while running / on failure, plus an overview-ruler tick.
      let blockSeq = 0;

      // Pixel height of one terminal row (for sizing multi-row block bands).
      const cellHeight = (): number => {
        const dims = (term as unknown as { _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } } })._core?._renderService?.dimensions?.css?.cell?.height;
        if (dims && dims > 0) return dims;
        const el = term.element;
        return el && term.rows ? el.clientHeight / term.rows : 17;
      };

      // Lay out every block as a pixel rectangle spanning from its prompt line
      // down to the next prompt (or the live cursor for the in-progress block).
      // Re-run on each render so blocks track new output and scrolling.
      const layoutBlocks = () => {
        const blocks = blocksRef.current;
        if (!blocks.length) return;
        const ch = cellHeight();
        const buf = term.buffer.active;
        const cursorLine = buf.baseY + buf.cursorY;
        for (let i = 0; i < blocks.length; i++) {
          const b = blocks[i];
          if (!b.el) continue;
          const start = b.marker.line;
          if (typeof start !== "number") continue;
          const nextStart = blocks[i + 1]?.marker.line;
          const end =
            typeof nextStart === "number" ? nextStart : cursorLine + 1;
          const rows = Math.max(1, end - start);
          const s = b.el.style;
          s.position = "absolute";
          s.left = "0";
          s.width = "100%";
          s.height = `${rows * ch}px`;
          s.boxSizing = "border-box";
          s.pointerEvents = "none";
          s.transition = "background 0.3s ease";
          // Faint alternating band so consecutive commands read as separate
          // regions, plus a crisp 1px divider above each block (skip the very
          // first) for a clean Warp-like boundary. A jumped-to block flashes
          // brighter briefly so ⌘↑/⌘↓ navigation is visible.
          s.background = b.flash
            ? "rgba(255,255,255,0.16)"
            : b.idx % 2 === 1
              ? "rgba(255,255,255,0.05)"
              : "rgba(255,255,255,0.015)";
          s.borderTop =
            i === 0 ? "none" : "1px solid rgba(255,255,255,0.09)";
          // Color-coded left status bar: blue while running, green on success,
          // red (bold) on failure — the at-a-glance signal for each command.
          const status = b.running
            ? "var(--accent)"
            : b.exitCode == null
              ? "transparent"
              : b.exitCode === 0
                ? "var(--success)"
                : "var(--danger)";
          s.borderLeft = `3px solid ${status}`;
        }
      };

      const onOsc133 = (data: string): boolean => {
        const [kind, ...rest] = data.split(";");
        if (kind === "A") {
          const marker = term.registerMarker(0);
          if (!marker) return true;
          // layer:"bottom" renders the band beneath the glyphs; width spans the
          // full row so the band covers the whole line.
          const decoration = term.registerDecoration({
            marker,
            width: term.cols,
            x: 0,
            layer: "bottom",
          });
          if (!decoration) {
            marker.dispose();
            return true;
          }
          const block: CmdBlock = {
            marker,
            decoration,
            el: null,
            running: false,
            exitCode: null,
            idx: blockSeq++,
            flash: false,
          };
          decoration.onRender((el) => {
            block.el = el;
            layoutBlocks();
          });
          marker.onDispose(() => {
            blocksRef.current = blocksRef.current.filter((x) => x !== block);
          });
          blocksRef.current.push(block);
          currentBlockRef.current = block;
          // A fresh prompt resets prompt-navigation to "latest".
          jumpAtRef.current = null;
          layoutBlocks(); // finalize the previous block's extent
        } else if (kind === "C") {
          const b = currentBlockRef.current;
          if (b) {
            b.running = true;
            layoutBlocks();
          }
        } else if (kind === "D") {
          const b = currentBlockRef.current;
          if (b) {
            const code = rest.length ? parseInt(rest[0], 10) : 0;
            b.exitCode = Number.isFinite(code) ? code : 0;
            b.running = false;
            layoutBlocks();
            // A zero-content decoration on the same marker draws the ruler tick
            // (color is fixed at creation, so we add it now that we know status).
            const ui = resolveTheme(settingsRef.current).ui;
            const tick = term.registerDecoration({
              marker: b.marker,
              overviewRulerOptions: {
                color: b.exitCode === 0 ? ui.success : ui.danger,
                position: "right",
              },
            });
            // Hide its in-viewport element so only the ruler mark shows.
            tick?.onRender((el) => {
              el.style.display = "none";
            });
          }
        }
        return true;
      };
      term.parser.registerOscHandler(133, onOsc133);
      // Expose layout so component-scope jumpPrompt can flash a jumped-to block.
      layoutBlocksRef.current = layoutBlocks;
      // Keep block bands sized as output streams in and the user scrolls.
      const blockRenderSub = term.onRender(() => layoutBlocks());

      // Make file-ish tokens in output clickable → open in the preview pane.
      term.registerLinkProvider({
        provideLinks(lineNo, cb) {
          const line = term.buffer.active.getLine(lineNo - 1);
          if (!line) return cb(undefined);
          const text = line.translateToString(true);
          const links = [];
          PATH_RE.lastIndex = 0;
          let m: RegExpExecArray | null;
          while ((m = PATH_RE.exec(text))) {
            const token = m[0];
            const startX = m.index + 1;
            links.push({
              range: {
                start: { x: startX, y: lineNo },
                end: { x: startX + token.length - 1, y: lineNo },
              },
              text: token,
              activate: () => {
                const abs = resolvePath(token, lastCwdRef.current);
                if (abs) onOpenPathRef.current?.(abs);
              },
            });
          }
          cb(links.length ? links : undefined);
        },
      });

      try {
        term.loadAddon(new WebglAddon());
      } catch {
        // WebGL2 unavailable — xterm falls back to the canvas renderer.
      }

      // Only fit if we actually have a box — background tabs mount hidden
      // (display:none) so they'd otherwise collapse to a tiny grid; they get
      // sized by the visible layout-effect when first shown.
      if (
        containerRef.current.offsetWidth > 0 &&
        containerRef.current.offsetHeight > 0
      ) {
        fitAddon.fit();
      }

      let disposed = false;
      let exitUnlisten: UnlistenFn | null = null;

      // Where we remember this pane's live PTY id (per webview session) so a
      // dev full-reload can reattach to the running shell instead of respawning.
      const storeKey =
        persistKey != null ? `rt-pty:${persistKey}` : null;

      const onBytes = (bytes: Uint8Array) => {
        if (disposed) return;
        term.write(bytes);
        // Output arriving while in the background = unseen activity.
        if (!visibleRef.current) onActivityRef.current?.();
      };

      // Wire input + focus once we own a PTY (whether freshly spawned or
      // reattached). The `rt` meta-command is provided as an executable on the
      // shell's PATH by the backend, so nothing is typed/echoed here.
      const wire = (id: number) => {
        ptyIdRef.current = id;
        if (storeKey) sessionStorage.setItem(storeKey, String(id));
        term.onData((data) => {
          writePty(id, data);
          onInputRef.current?.(data);
        });
        // Focusing the terminal should make this the focused pane.
        term.textarea?.addEventListener("focus", () =>
          onFocusRequestRef.current?.(),
        );
        if (focused) term.focus();

        // The backend emits `pty-exit-<id>` with the shell's exit code when the
        // process ends (typing `exit`, an SSH logout, a crash). Close the pane
        // on a clean exit; on an abnormal exit, leave it open with a dim notice
        // so the error stays readable. Forget the persisted id either way.
        listen<number>(`pty-exit-${id}`, (e) => {
          if (disposed) return;
          if (storeKey) sessionStorage.removeItem(storeKey);
          ptyIdRef.current = null;
          // Drop the now-dead backend session from the manager map (the wait
          // thread doesn't remove it). Harmless on an already-exited process.
          killPty(id);
          const code = e.payload ?? 0;
          if (code === 0) {
            onExitRef.current?.(code);
          } else {
            term.write(
              `\r\n\x1b[2m[process exited with code ${code}]\x1b[0m\r\n`,
            );
          }
        }).then((un) => {
          if (disposed) un();
          else exitUnlisten = un;
        });
      };

      const spawnFresh = () =>
        spawnPty(
          term.rows,
          term.cols,
          cwd,
          onBytes,
          profile,
          settingsRef.current.shellIntegration,
        ).then((id) => {
          if (disposed) {
            killPty(id);
            return;
          }
          wire(id);
        });

      const persistedId = storeKey
        ? Number(sessionStorage.getItem(storeKey))
        : NaN;

      if (storeKey && Number.isFinite(persistedId) && persistedId > 0) {
        // Try to reattach to the still-running shell (survives a full reload).
        attachPty(persistedId, term.rows, term.cols, onBytes)
          .then((ok) => {
            if (disposed) return;
            if (ok) wire(persistedId);
            else {
              sessionStorage.removeItem(storeKey);
              return spawnFresh();
            }
          })
          .catch(() => {
            if (!disposed) spawnFresh();
          });
      } else {
        spawnFresh();
      }

      // Copy-on-select: mirror the X11/iTerm convenience when enabled.
      term.onSelectionChange(() => {
        if (!settingsRef.current.copyOnSelect) return;
        const sel = term.getSelection();
        if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
      });

      const observer = new ResizeObserver(() => doFit());
      observer.observe(containerRef.current);

      return () => {
        disposed = true;
        exitUnlisten?.();
        blockRenderSub.dispose();
        observer.disconnect();
        // A real unmount (pane closed) kills the shell and forgets it. Note a
        // dev full-reload destroys the JS realm without running this cleanup,
        // so the PTY survives there and is reattached on the next mount.
        if (ptyIdRef.current != null) killPty(ptyIdRef.current);
        if (storeKey) sessionStorage.removeItem(storeKey);
        term.dispose();
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Re-apply settings live.
    useEffect(() => {
      const term = termRef.current;
      if (!term) return;
      term.options.fontFamily = settings.fontFamily;
      term.options.fontSize = settings.fontSize;
      term.options.cursorBlink = settings.cursorBlink;
      term.options.theme = resolveTheme(settings).terminal;
      doFit();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [settings]);

    // When this pane becomes visible (tab activated), refit BEFORE the browser
    // paints (useLayoutEffect) so the first visible frame is already at the
    // correct size — otherwise the stale WebGL canvas paints scaled for a frame
    // (the "zoomed in" flash). Then force a repaint at the new dimensions.
    useLayoutEffect(() => {
      if (!visible) return;
      doFit();
      const term = termRef.current;
      if (term) term.refresh(0, term.rows - 1);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visible]);

    // Focus the terminal when this becomes the focused pane.
    useEffect(() => {
      if (focused && visible) termRef.current?.focus();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focused, visible]);

    // While focused, poll the shell's cwd so the file browser can follow it.
    useEffect(() => {
      if (!focused) return;
      lastCwdRef.current = null; // force a report on (re)activation
      const poll = async () => {
        const id = ptyIdRef.current;
        if (id == null) return;
        const dir = await ptyCwd(id).catch(() => null);
        if (dir && dir !== lastCwdRef.current) {
          lastCwdRef.current = dir;
          onCwdChangeRef.current?.(dir);
        }
      };
      poll();
      const timer = setInterval(poll, 1000);
      return () => clearInterval(timer);
    }, [focused]);

    // Always poll the busy state: powers confirm-close and notify-when-done.
    // A command that ran >10s and finishes while the window is unfocused posts
    // a desktop notification.
    useEffect(() => {
      const poll = async () => {
        const id = ptyIdRef.current;
        if (id == null) return;
        const busy = await ptyBusy(id).catch(() => false);
        const was = busyRef.current;
        busyRef.current = busy;
        if (busy && !was) {
          busySinceRef.current = Date.now();
        } else if (!busy && was) {
          const since = busySinceRef.current;
          busySinceRef.current = null;
          const elapsed = since ? Date.now() - since : 0;
          if (
            settingsRef.current.notifyOnDone &&
            elapsed > 10_000 &&
            !document.hasFocus()
          ) {
            const secs = Math.round(elapsed / 1000);
            notify("Command finished", `Ran for ${secs}s in Rune`).catch(
              () => {},
            );
          }
        }
      };
      const timer = setInterval(poll, 1000);
      return () => clearInterval(timer);
    }, []);

    const copySelection = () => {
      const sel = termRef.current?.getSelection();
      if (sel) navigator.clipboard?.writeText(sel).catch(() => {});
    };
    const paste = async () => {
      const id = ptyIdRef.current;
      if (id == null) return;
      try {
        const text = await navigator.clipboard.readText();
        if (text) writePty(id, text);
      } catch {
        /* clipboard read denied */
      }
      termRef.current?.focus();
    };

    return (
      <div
        className="pane-host"
        style={{
          position: "relative",
          width: "100%",
          height: "100%",
          outline: focused ? "1px solid var(--accent)" : "none",
          outlineOffset: "-1px",
        }}
        onMouseDown={(e) => {
          onFocusRequest?.();
          // Middle-click paste (X11 primary-selection convention), opt-in.
          if (e.button === 1 && settings.middleClickPaste) {
            e.preventDefault();
            paste();
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          onFocusRequest?.();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {/* xterm owns this host node's DOM — keep it free of React children. */}
        <div
          ref={containerRef}
          style={{ width: "100%", height: "100%", padding: "4px 6px" }}
        />
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            items={[
              {
                label: "Copy",
                disabled: !termRef.current?.hasSelection(),
                onClick: copySelection,
              },
              { label: "Paste", onClick: paste },
              {
                label: "Select All",
                separator: true,
                onClick: () => termRef.current?.selectAll(),
              },
              {
                label: "Copy all output",
                onClick: () => {
                  const term = termRef.current;
                  if (!term) return;
                  const buf = term.buffer.active;
                  const lines: string[] = [];
                  for (let i = 0; i < buf.length; i++) {
                    const line = buf.getLine(i);
                    lines.push(line ? line.translateToString(true) : "");
                  }
                  while (lines.length && lines[lines.length - 1] === "")
                    lines.pop();
                  navigator.clipboard
                    ?.writeText(lines.join("\n"))
                    .catch(() => {});
                },
              },
              {
                label: "Clear",
                onClick: () => {
                  termRef.current?.clear();
                  termRef.current?.focus();
                },
              },
              ...(onClose && canClose
                ? [
                    {
                      label: "Close Pane",
                      separator: true,
                      onClick: onClose,
                    },
                  ]
                : []),
            ]}
            onClose={() => setMenu(null)}
          />
        )}
        {onClose && canClose && (
          <button
            className="pane-close"
            title="Close pane (⌘W)"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onClose();
            }}
          >
            <span aria-hidden>×</span>
          </button>
        )}
      </div>
    );
  },
);
