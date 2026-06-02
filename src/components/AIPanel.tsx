import { useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { type AiConfig, aiReady } from "../lib/ai/config";
import { useAgents } from "../lib/ai/manager";
import type { Item } from "../lib/ai/items";
import type { ToolCall } from "../lib/ai/types";
import { renderMarkdown } from "../lib/markdown";
import {
  diffLines,
  allAdded,
  diffStat,
  type DiffLine,
} from "../lib/diff";
import {
  IconPlus,
  IconClose,
  IconStop,
  IconSettings,
  IconSparkle,
  IconChevronRight,
  IconChevronDown,
  TOOL_ICON_COMPONENT,
} from "../lib/icons";

interface Props {
  config: AiConfig;
  /** Working directory of the focused pane — the agents' command context. */
  cwd: string;
  /** Read the active terminal's recent output/scrollback, for agent context. */
  readTerminal?: (lines?: number) => string | null;
  /** When true the panel is kept mounted but visually hidden, so in-flight
   *  agent runs (and their transcripts) survive closing the panel. */
  hidden?: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
}

/** Short label for a tool's card chip. */
const TOOL_LABEL: Record<string, string> = {
  run_command: "run",
  start_server: "server",
  read_output: "logs",
  read_file: "read",
  write_file: "write",
  edit_file: "edit",
  list_dir: "ls",
  list_agents: "agents",
  send_message: "message",
  spawn_agent: "spawn",
};

/** Present-tense verb shown while a tool is executing. */
const TOOL_VERB: Record<string, string> = {
  run_command: "Running",
  start_server: "Starting server",
  read_output: "Reading output",
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  list_dir: "Listing",
  list_agents: "Listing agents",
  send_message: "Messaging",
  spawn_agent: "Spawning agent",
};

/** Human-readable one-liner describing a tool call for its card header. */
function toolSummary(call: ToolCall): string {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    /* leave empty */
  }
  switch (call.name) {
    case "run_command":
    case "start_server":
      return String(args.command ?? "");
    case "read_output":
      return String(args.id ?? "");
    case "read_file":
    case "list_dir":
    case "write_file":
    case "edit_file":
      return String(args.path ?? "");
    case "send_message":
      return `→ ${String(args.to ?? "")}: ${String(args.message ?? "")}`;
    case "spawn_agent":
      return String(args.task ?? "");
    case "list_agents":
      return "";
    default:
      return call.arguments;
  }
}

/** Build a reviewable line-diff from a write_file / edit_file tool call, or
 *  null for any other tool. `edit_file` carries the exact old→new replacement;
 *  `write_file` carries the full new contents (shown as all additions). */
function toolDiff(call: ToolCall): DiffLine[] | null {
  if (call.name !== "edit_file" && call.name !== "write_file") return null;
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return null;
  }
  if (call.name === "write_file") {
    return allAdded(String(args.contents ?? ""));
  }
  const oldStr = String(args.old_string ?? "");
  const newStr = String(args.new_string ?? "");
  if (!oldStr && !newStr) return null;
  return diffLines(oldStr, newStr);
}

/** GitHub-style colorized line diff with gutter line numbers. */
function DiffView({ lines }: { lines: DiffLine[] }) {
  const { added, removed } = diffStat(lines);
  return (
    <div className="ai-diff">
      <div className="ai-diff-stat">
        <span className="ai-diff-add">+{added}</span>
        <span className="ai-diff-del">−{removed}</span>
      </div>
      <pre className="ai-diff-body">
        {lines.map((l, i) => (
          <div key={i} className={`ai-diff-line ai-diff-${l.op}`}>
            <span className="ai-diff-gutter">{l.oldNo ?? ""}</span>
            <span className="ai-diff-gutter">{l.newNo ?? ""}</span>
            <span className="ai-diff-sign">
              {l.op === "add" ? "+" : l.op === "del" ? "−" : " "}
            </span>
            <span className="ai-diff-text">{l.text || " "}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

/** Classify a finished tool result so the card can show success / failure.
 *  Returns null while still running (no result yet). */
function toolOk(result: string | null | undefined): boolean | null {
  if (result == null) return null;
  if (/^Error:/.test(result) || result.startsWith("The user denied"))
    return false;
  const m = result.match(/^exit code: (-?\d+)/m);
  if (m) return m[1] === "0";
  if (result.startsWith("The command was stopped")) return false;
  if (result.includes("already exited (it did not stay running)")) return false;
  return true;
}

/** Intercept clicks on links inside rendered Markdown so they open in the
 *  user's real browser instead of navigating the webview away from the app. */
function onMarkdownClick(e: React.MouseEvent<HTMLDivElement>) {
  const a = (e.target as HTMLElement).closest("a");
  const href = a?.getAttribute("href");
  if (!href) return;
  e.preventDefault();
  if (/^https?:\/\//i.test(href)) void openUrl(href);
}

/** A finished assistant turn, rendered as sanitized Markdown. Parsing happens
 *  once per unique text (memoized) and the result is handed to the browser as
 *  an HTML string — never a large React tree — so committing a long answer
 *  can't block the shared webview thread (which the terminal also runs on). */
function MarkdownMessage({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="ai-stream ai-md"
      onClick={onMarkdownClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Status dot color class for an agent tab. */
function dotClass(running: boolean, awaiting: boolean, status: string): string {
  if (awaiting) return "wait";
  if (running) return "run";
  if (status === "error") return "fail";
  if (status === "stopped") return "stop";
  return "done";
}

export function AIPanel({ config, cwd, readTerminal, hidden, onClose, onOpenSettings }: Props) {
  const {
    agents,
    selectedId,
    selected,
    select,
    start,
    send,
    stop,
    stopAll,
    removeAgent,
    resolveApproval,
    toggleTool,
    registerStreamSink,
    anyRunning,
  } = useAgents(config, cwd, readTerminal);

  const [input, setInput] = useState("");
  const ready = aiReady(config);

  // --- Live streaming paint (bounded to the selected agent) ----------------
  const liveAccum = useRef("");
  const paintedLen = useRef(0);
  const rafId = useRef<number | null>(null);
  const lastScroll = useRef(0);
  const streamElRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const streamingItemId = selected?.streamingItemId ?? null;

  // Append only the *new* slice of the selected agent's text to its live DOM
  // node — O(delta) per frame — bypassing React while a turn streams.
  const paintStream = () => {
    rafId.current = null;
    const el = streamElRef.current;
    if (!el) return;
    const full = liveAccum.current;
    if (el.childNodes.length === 0) paintedLen.current = 0;
    if (full.length > paintedLen.current) {
      el.appendChild(document.createTextNode(full.slice(paintedLen.current)));
      paintedLen.current = full.length;
    }
    const now = performance.now();
    const sc = scrollRef.current;
    if (sc && now - lastScroll.current > 160) {
      lastScroll.current = now;
      sc.scrollTop = sc.scrollHeight;
    }
  };

  // The manager calls this sink for each token of the *selected* agent only.
  useEffect(() => {
    registerStreamSink((accum) => {
      liveAccum.current = accum;
      if (rafId.current == null)
        rafId.current = requestAnimationFrame(paintStream);
    });
    return () => registerStreamSink(null);
  }, [registerStreamSink]);

  // Selection (or the streaming target) changed: repaint the live node from the
  // now-selected agent's accumulated text.
  useEffect(() => {
    if (rafId.current != null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    paintedLen.current = 0;
    liveAccum.current = selected?.streamAccum ?? "";
    if (streamElRef.current) streamElRef.current.textContent = "";
    if (streamingItemId != null && liveAccum.current)
      rafId.current = requestAnimationFrame(paintStream);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, streamingItemId]);

  // Keep the transcript scrolled to the bottom as items arrive.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, selected?.items.length]);

  const submit = () => {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (selectedId && selected) send(selectedId, text);
    else start(text);
  };

  const renderItem = (it: Item) => {
    if (it.kind === "user")
      return (
        <div key={it.id} className="ai-msg user">
          {it.text}
        </div>
      );
    if (it.kind === "note")
      return (
        <div key={it.id} className="ai-msg note">
          <span className="ai-note-from">{it.from} →</span> {it.text}
        </div>
      );
    if (it.kind === "info")
      return (
        <div key={it.id} className="ai-info">
          <span className="ai-info-icon" aria-hidden>
            ⚡
          </span>
          {it.text}
        </div>
      );
    if (it.kind === "assistant") {
      const streaming = it.id === streamingItemId;
      if (!streaming && !it.text) return null;
      return (
        <div key={it.id} className="ai-msg assistant">
          {/* While streaming we paint plain text straight to a DOM node (cheap,
              O(delta) per frame). When the turn finishes we render Markdown once
              from a memoized HTML string via innerHTML, which the browser parses
              far faster than a React element tree, so the shared webview thread
              (and the terminal) never freezes. */}
          {streaming ? (
            <div className="ai-stream" ref={streamElRef} />
          ) : (
            <MarkdownMessage text={it.text} />
          )}
        </div>
      );
    }
    if (it.kind === "error")
      return (
        <div key={it.id} className="ai-msg error">
          {it.text}
        </div>
      );
    // Tool card.
    const live = it.result == null && !it.awaiting;
    const ok = toolOk(it.result);
    const state = it.awaiting ? "wait" : live ? "live" : ok === false ? "fail" : "ok";
    const server = it.call.name === "start_server";
    const diff = toolDiff(it.call);
    return (
      <div
        key={it.id}
        className={`ai-tool ai-tool-${state}${server ? " ai-tool-server" : ""}`}
      >
        <button
          className="ai-tool-head"
          disabled={it.result == null}
          onClick={() => toggleTool(selectedId, it.id)}
          title={
            live
              ? `${TOOL_VERB[it.call.name] ?? "Running"}…`
              : it.result != null
                ? it.expanded
                  ? "Hide output"
                  : "Show output"
                : undefined
          }
        >
          <span className="ai-tool-icon" aria-hidden>
            {(() => {
              const TIcon = TOOL_ICON_COMPONENT[it.call.name];
              return TIcon ? <TIcon size={13} /> : <IconChevronRight size={13} />;
            })()}
          </span>
          <span className="ai-tool-name">
            {TOOL_LABEL[it.call.name] ?? it.call.name}
          </span>
          <code className="ai-tool-arg">{toolSummary(it.call)}</code>
          {live ? (
            <span className="ai-spinner" title="Running…" />
          ) : it.awaiting ? (
            <span className="ai-tool-status wait" title="Awaiting approval">
              ⏸
            </span>
          ) : ok === false ? (
            <span className="ai-tool-status fail" title="Failed">
              ✕
            </span>
          ) : (
            <span className="ai-tool-status ok" title="Done">
              ✓
            </span>
          )}
          {it.result != null && (
            <span className="ai-tool-caret">
              {it.expanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
            </span>
          )}
        </button>
        {/* Patch preview: shown while awaiting approval so the change can be
            reviewed before it's applied, and on expand afterwards. */}
        {diff && (it.awaiting || it.expanded) && <DiffView lines={diff} />}
        {it.awaiting && (
          <div className="ai-approve">
            <span>
              {diff ? "Apply this change?" : "Approve this action?"}
            </span>
            <button className="primary" onClick={() => resolveApproval(selectedId, true)}>
              {diff ? "Apply" : "Approve"}
            </button>
            <button onClick={() => resolveApproval(selectedId, false)}>Deny</button>
          </div>
        )}
        {it.expanded &&
          it.result != null &&
          (!diff || ok === false) && (
            <pre className="ai-tool-result">{it.result}</pre>
          )}
      </div>
    );
  };

  const thinking =
    selected?.running &&
    streamingItemId === null &&
    !selected.pending &&
    !selected.items.some((it) => it.kind === "tool" && it.result == null);

  return (
    <div className="ai-panel" style={hidden ? { display: "none" } : undefined}>
      <div className="ai-head">
        <span className="ai-title">
          <IconSparkle size={13} /> AI Assistant
        </span>
        <div className="ai-head-actions">
          <button
            className="icon-btn"
            title="New task"
            onClick={() => {
              select("");
              inputRef.current?.focus();
            }}
          >
            <IconPlus size={15} />
          </button>
          {anyRunning && (
            <button className="icon-btn" title="Stop all agents" onClick={stopAll}>
              <IconStop size={15} />
            </button>
          )}
          <button className="icon-btn" title="AI settings" onClick={onOpenSettings}>
            <IconSettings size={15} />
          </button>
          <button className="icon-btn" title="Close (⌘I)" onClick={onClose}>
            <IconClose size={15} />
          </button>
        </div>
      </div>

      {!ready ? (
        <div className="ai-setup">
          <p>
            Bring your own API key or connect a local model (Ollama, LM Studio)
            to enable the assistant.
          </p>
          <button className="primary" onClick={onOpenSettings}>
            Configure AI
          </button>
        </div>
      ) : (
        <>
          {agents.length > 0 && (
            <div className="ai-tabs">
              {agents.map((a) => (
                <div
                  key={a.id}
                  className={`ai-tab${a.id === selectedId ? " active" : ""}`}
                  onClick={() => select(a.id)}
                  title={`${a.name}: ${a.activity}`}
                >
                  <span className={`ai-dot ${dotClass(a.running, a.awaiting, a.status)}`} />
                  <span className="ai-tab-name">{a.name}</span>
                  {a.running ? (
                    <span className="ai-tab-activity">{a.activity}</span>
                  ) : (
                    <button
                      className="ai-tab-close"
                      title="Close task"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeAgent(a.id);
                      }}
                    >
                      <IconClose size={12} />
                    </button>
                  )}
                </div>
              ))}
              <div
                className={`ai-tab new${selectedId === "" ? " active" : ""}`}
                onClick={() => select("")}
                title="New task"
              >
                <IconPlus size={14} />
              </div>
            </div>
          )}

          <div className="ai-messages" ref={scrollRef}>
            {!selected ? (
              <div className="ai-empty">
                Start a task and I'll work in <code>{cwd}</code>. Run several at
                once; they work in parallel and can coordinate.
              </div>
            ) : (
              <>
                {selected.items.map(renderItem)}
                {thinking && (
                  <div className="ai-working">
                    <span className="ai-spinner" />
                    Thinking…
                  </div>
                )}
              </>
            )}
          </div>

          {selected?.paused && !selected.running && (
            <div className="ai-paused">
              <span>Paused at the step limit.</span>
              <button
                className="ai-continue"
                onClick={() => send(selectedId, "continue")}
              >
                Continue
              </button>
            </div>
          )}

          <div className="ai-input">
            <textarea
              ref={inputRef}
              rows={2}
              placeholder={
                selectedId
                  ? selected?.running
                    ? "Send a message to this agent…"
                    : "Continue this task…"
                  : "Describe a task to start a new agent…"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
            />
            {selected?.running ? (
              <button className="ai-send stop" onClick={() => stop(selectedId)}>
                Stop
              </button>
            ) : (
              <button
                className="ai-send primary"
                onClick={submit}
                disabled={!input.trim()}
              >
                {selectedId ? "Send" : "Start"}
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
