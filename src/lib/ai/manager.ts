/** Multi-agent session manager.
 *
 *  Each "agent" is an independent `runAgent` loop with its own conversation,
 *  approval/stop state, and A2A inbox. Several run concurrently — they simply
 *  interleave on the JS event loop while the Rust backend handles parallel
 *  model streams and commands. Agents are self-aware (identity in their system
 *  prompt) and can list / message / spawn each other through the A2A tools.
 *
 *  Rendering cost is bounded by only ever live-painting the *selected* agent's
 *  stream (token-by-token); background agents accumulate their text silently and
 *  render it when you switch to them. */
import { useCallback, useRef, useState } from "react";
import { runAgent, type AgentCallbacks, type AgentOptions } from "./agent";
import { cancelChat, cancelCommand } from "./client";
import { type AiConfig, activeProvider } from "./config";
import { type Item, itemsFromMessages } from "./items";
import type { ChatMessage } from "./types";

export type AgentStatus = "running" | "done" | "error" | "stopped";

/** A single agent session. Mutated in place; structural changes call `bump()`
 *  to re-render. The selected agent's streaming text is painted directly to the
 *  DOM by the panel (see `streamAccum`). */
interface Session {
  id: string;
  name: string;
  /** The first prompt — used as the peer-facing task description and tab title. */
  task: string;
  status: AgentStatus;
  /** Canonical conversation. */
  history: ChatMessage[];
  /** Derived display transcript. */
  items: Item[];
  /** Next display-item id. */
  uid: number;
  /** Current turn's streamed text (painted live only while selected). */
  streamAccum: string;
  streamingItemId: number | null;
  /** A `runAgent` loop is currently active. */
  running: boolean;
  /** Stop flag observed by the loop. */
  stop: boolean;
  /** True when the last run hit the step limit with work still pending. Cleared
   *  on the next run. Drives the panel's "Continue" affordance. */
  paused: boolean;
  pending: { id: string; resolve: (ok: boolean) => void } | null;
  liveCommands: Set<string>;
  liveStream: string | null;
  /** Messages delivered by peers, drained at each loop step. */
  inbox: { from: string; text: string }[];
  /** Last compaction tier surfaced to the UI, to avoid a note every step. */
  compactState: "none" | "elide" | "drop";
}

/** What the panel renders per tab. */
export interface AgentView {
  id: string;
  name: string;
  task: string;
  status: AgentStatus;
  running: boolean;
  awaiting: boolean;
  /** Paused at the step limit with work pending — panel shows "Continue". */
  paused: boolean;
  /** A one-line "what it's doing right now" hint for the tab strip. */
  activity: string;
}

const STORE_KEY = "ai.agents.v1";

function genId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 8)
    : `a${Date.now().toString(36)}`;
}

/** A short, present-tense description of what a session is doing, for the tab. */
function activityOf(s: Session): string {
  if (!s.running) return s.status;
  const tool = [...s.items].reverse().find((it) => it.kind === "tool" && it.result == null);
  if (tool && tool.kind === "tool") {
    if (tool.awaiting) return "awaiting approval";
    return `${tool.call.name}…`;
  }
  return s.streamingItemId != null ? "responding…" : "thinking…";
}

interface PersistedSession {
  id: string;
  name: string;
  task: string;
  status: AgentStatus;
  history: ChatMessage[];
}

function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as PersistedSession[];
    return arr.map((p) => ({
      id: p.id,
      name: p.name,
      task: p.task,
      status: p.status === "running" ? "stopped" : p.status,
      history: p.history,
      items: itemsFromMessages(p.history),
      uid: 100000, // keep restored ids well clear of fresh ones
      streamAccum: "",
      streamingItemId: null,
      running: false,
      stop: false,
      paused: false,
      pending: null,
      liveCommands: new Set(),
      liveStream: null,
      inbox: [],
      compactState: "none",
    }));
  } catch {
    return [];
  }
}

export interface UseAgents {
  agents: AgentView[];
  selectedId: string;
  selected: {
    id: string;
    name: string;
    status: AgentStatus;
    running: boolean;
    paused: boolean;
    items: Item[];
    streamingItemId: number | null;
    streamAccum: string;
    pending: boolean;
  } | null;
  select: (id: string) => void;
  /** Start a brand-new agent on `prompt` and select it. */
  start: (prompt: string) => void;
  /** Continue the selected agent (or queue a message if it's running). */
  send: (id: string, text: string) => void;
  stop: (id: string) => void;
  stopAll: () => void;
  removeAgent: (id: string) => void;
  resolveApproval: (id: string, ok: boolean) => void;
  toggleTool: (id: string, toolId: string) => void;
  /** Register the panel's per-delta paint sink for the selected agent. */
  registerStreamSink: (cb: ((accum: string) => void) | null) => void;
  anyRunning: boolean;
}

export function useAgents(
  config: AiConfig,
  cwd: string,
  readTerminal?: (lines?: number) => string | null,
): UseAgents {
  // One-time restore of persisted sessions, computed before the hooks that
  // depend on the initial selection. `boot` is a plain ref guard (not a hook
  // branch), so hook order stays stable.
  const boot = useRef<{ map: Map<string, Session>; order: string[]; first: string } | null>(null);
  if (!boot.current) {
    const map = new Map<string, Session>();
    const ord: string[] = [];
    for (const s of loadSessions()) {
      map.set(s.id, s);
      ord.push(s.id);
    }
    boot.current = { map, order: ord, first: ord[0] ?? "" };
  }

  const sessions = useRef<Map<string, Session>>(boot.current.map);
  const order = useRef<string[]>(boot.current.order);
  const seq = useRef(1);
  const selectedIdRef = useRef(boot.current.first);
  const streamSink = useRef<((accum: string) => void) | null>(null);
  // Kept fresh each render so the active terminal accessor never goes stale
  // without forcing makeOpts to re-create on every focus change.
  const readTerminalRef = useRef(readTerminal);
  readTerminalRef.current = readTerminal;

  const [, setTick] = useState(0);
  const [selectedId, setSelectedId] = useState(boot.current.first);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  void selectedId; // re-render trigger; canonical value lives in selectedIdRef

  const persist = useCallback(() => {
    const arr: PersistedSession[] = order.current
      .map((id) => sessions.current.get(id))
      .filter((s): s is Session => !!s)
      .map((s) => ({
        id: s.id,
        name: s.name,
        task: s.task,
        status: s.status,
        history: s.history,
      }));
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(arr));
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, []);

  const findSession = useCallback((to: string): Session | undefined => {
    const key = to.trim().toLowerCase();
    for (const s of sessions.current.values()) {
      if (s.id.toLowerCase() === key || s.name.toLowerCase() === key) return s;
    }
    return undefined;
  }, []);

  const makeCallbacks = useCallback(
    (s: Session): AgentCallbacks => ({
      onAssistantStart: () => {
        const aid = s.uid++;
        s.streamingItemId = aid;
        s.streamAccum = "";
        s.items = [...s.items, { kind: "assistant", id: aid, text: "" }];
        bump();
      },
      onNote: (from, text) => {
        s.items = [...s.items, { kind: "note", id: s.uid++, from, text }];
        bump();
      },
      onStream: (sid) => {
        s.liveStream = sid;
        if (sid === null) {
          // Commit the streamed turn: store the final text (rendered as Markdown)
          // or drop the bubble if it was empty (e.g. a tool-only turn).
          const aid = s.streamingItemId;
          const finalText = s.streamAccum;
          s.streamAccum = "";
          s.streamingItemId = null;
          if (aid != null) {
            s.items = finalText
              ? s.items.map((it) =>
                  it.kind === "assistant" && it.id === aid
                    ? { ...it, text: finalText }
                    : it,
                )
              : s.items.filter((it) => !(it.kind === "assistant" && it.id === aid));
          }
          bump();
        }
      },
      onText: (delta) => {
        s.streamAccum += delta;
        // Only the visible agent paints token-by-token; others accumulate quietly.
        if (s.id === selectedIdRef.current) streamSink.current?.(s.streamAccum);
      },
      onCompact: (info) => {
        // Surface a single, low-noise note when the compaction tier changes,
        // not on every step it stays compacted.
        const tier = info.droppedMessages > 0 ? "drop" : "elide";
        if (tier === s.compactState) return;
        s.compactState = tier;
        const saved = Math.max(0, info.beforeTokens - info.afterTokens);
        const detail =
          info.droppedMessages > 0
            ? `${info.droppedMessages} old messages summarized`
            : `${info.elidedTools} tool outputs trimmed`;
        s.items = [
          ...s.items,
          {
            kind: "info",
            id: s.uid++,
            text: `Context compacted: ${detail} (~${saved.toLocaleString()} tokens saved).`,
          },
        ];
        bump();
      },
      onInfo: (text) => {
        s.items = [...s.items, { kind: "info", id: s.uid++, text }];
        bump();
      },
      onPaused: () => {
        s.paused = true;
        bump();
      },
      onToolCall: (call) => {
        if (call.name === "run_command" || call.name === "start_server")
          s.liveCommands.add(call.id);
        s.items = [...s.items, { kind: "tool", id: call.id, call }];
        bump();
      },
      onToolResult: (tid, result) => {
        s.liveCommands.delete(tid);
        s.items = s.items.map((it) =>
          it.kind === "tool" && it.id === tid ? { ...it, result } : it,
        );
        bump();
      },
      requestApproval: (call) =>
        new Promise<boolean>((resolve) => {
          s.items = s.items.map((it) =>
            it.kind === "tool" && it.id === call.id
              ? { ...it, awaiting: true }
              : it,
          );
          s.pending = { id: call.id, resolve };
          bump();
        }),
      onError: (message) => {
        s.items = [...s.items, { kind: "error", id: s.uid++, text: message }];
        bump();
      },
    }),
    [bump],
  );

  const makeOpts = useCallback(
    (s: Session): AgentOptions => ({
      provider: activeProvider(config)!,
      cwd,
      autoApprove: config.autoApprove,
      shouldStop: () => s.stop,
      self: { id: s.id, name: s.name },
      peers: () =>
        [...sessions.current.values()]
          .filter((x) => x.id !== s.id)
          .map((x) => ({
            id: x.id,
            name: x.name,
            status: x.status,
            task: x.task,
          })),
      sendMessage: (to, text) => deliver(s.name, to, text),
      spawnAgent: (name, task) => {
        const child = createSession(name, task);
        runSession(child);
        bump();
        return child.name;
      },
      drainInbox: () => {
        const m = s.inbox;
        s.inbox = [];
        return m;
      },
      readTerminal: (lines) => readTerminalRef.current?.(lines) ?? null,
      maxContextTokens: config.autoCompact ? config.maxContextTokens : 0,
      maxSteps: config.maxSteps,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, cwd],
  );

  const runSession = useCallback(
    async (s: Session) => {
      if (s.running) return;
      const provider = activeProvider(config);
      if (!provider) {
        s.status = "error";
        s.items = [
          ...s.items,
          { kind: "error", id: s.uid++, text: "No AI provider configured." },
        ];
        bump();
        return;
      }
      s.running = true;
      s.status = "running";
      s.stop = false;
      s.paused = false;
      s.compactState = "none";
      bump();
      try {
        s.history = await runAgent(s.history, makeOpts(s), makeCallbacks(s));
        s.status = s.stop ? "stopped" : "done";
      } catch (e) {
        s.status = "error";
        s.items = [
          ...s.items,
          { kind: "error", id: s.uid++, text: String(e) },
        ];
      } finally {
        s.running = false;
        s.liveCommands.clear();
        s.liveStream = null;
        s.pending = null;
        bump();
        persist();
        // Messages that arrived as the run wound down: process them now.
        if (s.inbox.length && !s.stop) void runSession(s);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config, makeOpts, makeCallbacks, persist],
  );

  const createSession = useCallback(
    (name: string, prompt: string): Session => {
      const id = genId();
      const s: Session = {
        id,
        name: name.trim() || `Agent ${seq.current++}`,
        task: prompt,
        status: "running",
        history: [{ role: "user", content: prompt }],
        items: [{ kind: "user", id: 0, text: prompt }],
        uid: 1,
        streamAccum: "",
        streamingItemId: null,
        running: false,
        stop: false,
        paused: false,
        pending: null,
        liveCommands: new Set(),
        liveStream: null,
        inbox: [],
        compactState: "none",
      };
      sessions.current.set(id, s);
      order.current.push(id);
      return s;
    },
    [],
  );

  /** Deliver a peer message; wake the recipient if it is idle. */
  const deliver = useCallback(
    (fromName: string, to: string, text: string): boolean => {
      const target = findSession(to);
      if (!target) return false;
      target.inbox.push({ from: fromName, text });
      if (!target.running) void runSession(target);
      bump();
      return true;
    },
    [findSession, runSession, bump],
  );

  const start = useCallback(
    (prompt: string) => {
      const s = createSession("", prompt);
      selectedIdRef.current = s.id;
      setSelectedId(s.id);
      void runSession(s);
      bump();
    },
    [createSession, runSession, bump],
  );

  const send = useCallback(
    (id: string, text: string) => {
      const s = sessions.current.get(id);
      if (!s) return;
      if (s.running) {
        // Queue as a peer-style note from the user; the loop drains it.
        s.inbox.push({ from: "user", text });
        bump();
        return;
      }
      s.history.push({ role: "user", content: text });
      s.items = [...s.items, { kind: "user", id: s.uid++, text }];
      void runSession(s);
      bump();
    },
    [runSession, bump],
  );

  const stop = useCallback(
    (id: string) => {
      const s = sessions.current.get(id);
      if (!s) return;
      s.stop = true;
      if (s.pending) {
        s.pending.resolve(false);
        s.pending = null;
      }
      if (s.liveStream) void cancelChat(s.liveStream);
      for (const cid of s.liveCommands) void cancelCommand(cid);
      bump();
    },
    [bump],
  );

  const stopAll = useCallback(() => {
    for (const id of order.current) stop(id);
  }, [stop]);

  const removeAgent = useCallback(
    (id: string) => {
      const s = sessions.current.get(id);
      if (s?.running) stop(id);
      sessions.current.delete(id);
      order.current = order.current.filter((x) => x !== id);
      if (selectedIdRef.current === id) {
        selectedIdRef.current = order.current[0] ?? "";
        setSelectedId(selectedIdRef.current);
      }
      persist();
      bump();
    },
    [stop, persist, bump],
  );

  const resolveApproval = useCallback(
    (id: string, ok: boolean) => {
      const s = sessions.current.get(id);
      if (!s?.pending) return;
      const p = s.pending;
      s.pending = null;
      s.items = s.items.map((it) =>
        it.kind === "tool" && it.id === p.id
          ? { ...it, awaiting: false, approved: ok }
          : it,
      );
      p.resolve(ok);
      bump();
    },
    [bump],
  );

  const toggleTool = useCallback(
    (id: string, toolId: string) => {
      const s = sessions.current.get(id);
      if (!s) return;
      s.items = s.items.map((it) =>
        it.kind === "tool" && it.id === toolId
          ? { ...it, expanded: !it.expanded }
          : it,
      );
      bump();
    },
    [bump],
  );

  const select = useCallback((id: string) => {
    selectedIdRef.current = id;
    setSelectedId(id);
  }, []);

  const registerStreamSink = useCallback(
    (cb: ((accum: string) => void) | null) => {
      streamSink.current = cb;
    },
    [],
  );

  // Build the view models fresh each render.
  const agents: AgentView[] = order.current
    .map((id) => sessions.current.get(id))
    .filter((s): s is Session => !!s)
    .map((s) => ({
      id: s.id,
      name: s.name,
      task: s.task,
      status: s.status,
      running: s.running,
      awaiting: s.pending != null,
      paused: s.paused,
      activity: activityOf(s),
    }));

  const sel = sessions.current.get(selectedIdRef.current) ?? null;
  const selected = sel
    ? {
        id: sel.id,
        name: sel.name,
        status: sel.status,
        running: sel.running,
        paused: sel.paused,
        items: sel.items,
        streamingItemId: sel.streamingItemId,
        streamAccum: sel.streamAccum,
        pending: sel.pending != null,
      }
    : null;

  return {
    agents,
    selectedId: selectedIdRef.current,
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
    anyRunning: agents.some((a) => a.running),
  };
}
