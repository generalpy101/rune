/** The agent harness: a tool-using loop over a streaming model turn.
 *
 *  Each step streams one assistant turn; if the model requested tools, they are
 *  executed (commands/writes gated by approval) and their results fed back, then
 *  the loop repeats until the model answers with no further tool calls. */
import { listDir, readFile, writeFile } from "../fs";
import { runBackground, runCommand, readOutput, streamChat } from "./client";
import {
  compactForModel,
  estimateTokens,
  DEFAULT_CONTEXT_TOKENS,
  type CompactInfo,
} from "./context";
import type { ProviderConfig } from "./config";
import type { ChatMessage, ToolCall, ToolDef } from "./types";

/** Default tool-step budget when the caller doesn't specify one. */
const MAX_STEPS = 50;
/** Within this many steps of the budget, nudge the model to wrap up so it
 *  concludes gracefully instead of being cut off mid-action. */
const WRAP_UP_WINDOW = 3;
/** Cap tool output fed back to the model so a noisy command can't blow context. */
const MAX_TOOL_OUTPUT = 12_000;

export const TOOLS: ToolDef[] = [
  {
    name: "run_command",
    description:
      "Run a shell command in the current working directory and return its stdout, stderr, and exit code. Use for builds, tests, git, ls, grep, etc. Non-interactive only.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run." },
      },
      required: ["command"],
    },
  },
  {
    name: "start_server",
    description:
      "Start a long-running background process — a dev server, file watcher, or any command that does not exit on its own (e.g. `npm run dev`, `vite`, `next dev`, `tail -f`). Returns after a few seconds with the initial output; the process keeps running in the background. Use this INSTEAD OF run_command for anything that stays alive. Use read_output to check on it later.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to start." },
      },
      required: ["command"],
    },
  },
  {
    name: "read_output",
    description:
      "Read the latest captured output of a background process started with start_server, and whether it is still running. Pass the id returned by that start_server call.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The id of the background process." },
      },
      required: ["id"],
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Path may be absolute or relative to the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description:
      "Create or overwrite a text file with the given contents. Path may be absolute or relative to the working directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        contents: { type: "string" },
      },
      required: ["path", "contents"],
    },
  },
  {
    name: "edit_file",
    description:
      "Make a precise edit to an existing text file by replacing an exact string. Prefer this over write_file when changing an existing file: it is cheaper and safer than rewriting the whole file. `old_string` must match the file exactly, including indentation and whitespace, and must be unique unless `replace_all` is true — include enough surrounding context to pin down the one spot. To insert or delete code, include the surrounding lines in `old_string`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: {
          type: "string",
          description: "The exact existing text to replace (verbatim, including whitespace).",
        },
        new_string: {
          type: "string",
          description: "The replacement text.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace every occurrence instead of requiring a unique match. Default false.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory. Path may be absolute or relative to the working directory.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "read_terminal",
    description:
      "Read what is currently on the user's active terminal pane — the commands they have been typing and the output shown, including scrollback. Use this to ground your help in the user's real context: what they just ran, an error they are looking at, or the current state of their shell session. This is the live screen the user sees, not a command you run.",
    parameters: {
      type: "object",
      properties: {
        lines: {
          type: "number",
          description: "How many trailing lines of the terminal to read (default 200).",
        },
      },
    },
  },
];

/** Agent-to-agent tools — only offered when this run has an identity (i.e. it is
 *  part of a multi-agent session). They let an agent see its peers, message
 *  them, and spawn new agents to parallelize work. None are destructive. */
export const A2A_TOOLS: ToolDef[] = [
  {
    name: "list_agents",
    description:
      "List the other agents currently active in this session (and yourself), with their names, ids, status, and what they are working on. Use this before messaging or coordinating with a peer.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "send_message",
    description:
      "Send a message to another agent so you can coordinate, hand off work, share a finding, or ask a question. The recipient receives it in their conversation and will act on it. Address them by name or id (see list_agents).",
    parameters: {
      type: "object",
      properties: {
        to: { type: "string", description: "The recipient agent's name or id." },
        message: { type: "string", description: "The message to send." },
      },
      required: ["to", "message"],
    },
  },
  {
    name: "spawn_agent",
    description:
      "Start a brand-new agent to work on a sub-task in parallel with you. Use this to split independent work across agents. Returns the new agent's name so you can message it. Give it a clear, self-contained task description.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "A short name for the new agent (e.g. \"tests\", \"docs\"). Optional.",
        },
        task: {
          type: "string",
          description: "A clear, self-contained description of what the new agent should do.",
        },
      },
      required: ["task"],
    },
  },
];

/** Tools that change state and therefore need user approval. */
const DESTRUCTIVE = new Set([
  "run_command",
  "write_file",
  "edit_file",
  "start_server",
]);

/** Tools that only read state — safe to run concurrently within a turn (they
 *  never need approval, so they don't contend for the single approval slot). */
const READ_ONLY = new Set([
  "read_file",
  "list_dir",
  "read_terminal",
  "read_output",
  "list_agents",
]);

export function systemPrompt(opts: AgentOptions): string {
  const lines = [
    "You are an expert engineering assistant embedded in a macOS terminal app.",
    "You help the user accomplish tasks by reasoning and using the provided tools.",
    `The current working directory is: ${opts.cwd}`,
    "The host OS is macOS; the shell is the user's default ($SHELL).",
  ];

  if (opts.self) {
    lines.push(
      "",
      `You are one of several agents that can run at the same time. Your identity: ${opts.self.name} (id: ${opts.self.id}).`,
      "Use list_agents to see who else is active and what they are doing.",
      "Use send_message to coordinate with a peer — hand off work, share findings, or ask a question.",
      "Use spawn_agent to split clearly independent work into a parallel agent, then message it if needed.",
      "Only coordinate when it genuinely helps; for a simple self-contained task just do the work yourself.",
    );
  }

  lines.push(
    "",
    "Guidelines:",
    "- Inspect real state with tools instead of guessing: read files and run commands before drawing conclusions.",
    "- Read a file before editing it, so your edit matches the exact current text.",
    "- To change an existing file use edit_file (a precise string replacement). Only use write_file to create a new file or fully replace one — never rewrite a whole file just to change a few lines.",
    "- You can call several read-only tools (read_file, list_dir, read_terminal) in one turn; they run in parallel.",
    "- Use read_terminal to see what is currently on the user's terminal (recent commands and output) when it helps you understand their context or an error they hit.",
    "- Use relative paths from the working directory when natural.",
    "- run_command is for one-shot, non-interactive commands that exit on their own (builds, tests, git, ls, grep). It is force-killed after a timeout, so never use it for REPLs, editors, pagers, or anything long-running. Append flags like --no-pager or pipe to cat where needed.",
    "- For anything that stays alive (dev servers, watchers: `npm run dev`, `vite`, `tail -f`), use start_server instead, then read_output to inspect its logs.",
    "- Verify your work when practical: after edits, run the build/test/linter to confirm it's correct.",
    "- Be concise. After tools return, briefly say what you found or did; don't narrate every step.",
    "- If an action is risky or destructive, explain why before proposing it.",
  );

  return lines.join("\n");
}

function resolvePath(cwd: string, p: string): string {
  if (!p) return cwd;
  if (p.startsWith("/")) return p;
  if (p === "~" || p.startsWith("~/")) return p; // shell/home handled elsewhere
  return cwd.endsWith("/") ? cwd + p : `${cwd}/${p}`;
}

/** Cap large tool output, keeping both the head *and* the tail — the end of a
 *  build/test log (where the actual error usually is) is as important as the
 *  start, so a plain head-only cut would hide failures. */
function truncate(s: string): string {
  if (s.length <= MAX_TOOL_OUTPUT) return s;
  const head = Math.floor(MAX_TOOL_OUTPUT * 0.6);
  const tail = MAX_TOOL_OUTPUT - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n…[${omitted.toLocaleString()} chars elided]…\n${s.slice(s.length - tail)}`;
}

/** Generate a per-turn stream id used to cancel a hung model stream. */
function streamId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A peer agent in the same multi-agent session. */
export interface AgentPeer {
  id: string;
  name: string;
  status: string;
  /** Brief description of what the peer is working on (its first prompt). */
  task: string;
}

/** A message delivered to this agent from a peer (A2A). */
export interface InboxMessage {
  from: string;
  text: string;
}

export interface AgentCallbacks {
  /** A new assistant turn began (push an empty assistant bubble). */
  onAssistantStart: () => void;
  /** A peer message was delivered into this agent's conversation. */
  onNote?: (from: string, text: string) => void;
  /** The active model stream id (string while streaming, null when it ends),
   *  so the UI can cancel a hung stream via `cancelChat`. */
  onStream?: (id: string | null) => void;
  /** Streaming text delta for the current assistant turn. */
  onText: (delta: string) => void;
  /** The model-facing transcript was compacted to fit the context budget. */
  onCompact?: (info: CompactInfo) => void;
  /** A low-noise informational notice for the user (e.g. hit the step limit). */
  onInfo?: (text: string) => void;
  /** The run paused at the step limit with work still pending — the UI can offer
   *  a "Continue" affordance. Not fired on normal completion or user stop. */
  onPaused?: () => void;
  /** The model requested a tool. */
  onToolCall: (call: ToolCall) => void;
  /** A tool finished; `result` is what the model will see. */
  onToolResult: (id: string, result: string) => void;
  /** Ask the user to approve a destructive tool call; resolve true to run it. */
  requestApproval: (call: ToolCall) => Promise<boolean>;
  onError: (message: string) => void;
}

export interface AgentOptions {
  provider: ProviderConfig;
  cwd: string;
  autoApprove: boolean;
  /** Set true to stop the loop after the current step. */
  shouldStop: () => boolean;
  /** This agent's identity, when part of a multi-agent session. Enables the
   *  A2A tools and self-aware system prompt. */
  self?: { id: string; name: string };
  /** Snapshot of the other agents in the session (for list_agents). */
  peers?: () => AgentPeer[];
  /** Deliver a message to another agent by name or id. Returns false on no match. */
  sendMessage?: (to: string, text: string) => boolean;
  /** Spawn a new agent with a task. Returns its name, or null if unavailable. */
  spawnAgent?: (name: string, task: string) => string | null;
  /** Drain messages delivered to this agent since the last check. */
  drainInbox?: () => InboxMessage[];
  /** Read the user's active terminal buffer (recent output + scrollback). */
  readTerminal?: (lines?: number) => string | null;
  /** Approximate token budget for the model-facing transcript before it is
   *  compacted. 0 (or undefined) disables compaction. */
  maxContextTokens?: number;
  /** Max tool-using steps before the run pauses. Falls back to MAX_STEPS. */
  maxSteps?: number;
}

async function executeTool(
  call: ToolCall,
  opts: AgentOptions,
  cb: AgentCallbacks,
): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(call.arguments || "{}");
  } catch {
    return "Error: arguments were not valid JSON.";
  }

  if (DESTRUCTIVE.has(call.name) && !opts.autoApprove) {
    const ok = await cb.requestApproval(call);
    if (!ok) return "The user denied this action.";
  }

  try {
    switch (call.name) {
      case "run_command": {
        const out = await runCommand(opts.cwd, String(args.command ?? ""), call.id);
        const parts = out.killed
          ? ["The command was stopped (interrupted by the user or it exceeded the time limit)."]
          : [`exit code: ${out.code ?? "null"}`];
        if (out.stdout.trim()) parts.push(`stdout:\n${out.stdout}`);
        if (out.stderr.trim()) parts.push(`stderr:\n${out.stderr}`);
        return truncate(parts.join("\n"));
      }
      case "start_server": {
        const out = await runBackground(opts.cwd, String(args.command ?? ""), call.id);
        const status = out.running
          ? `The process is running in the background (id: ${out.id}). Use read_output with this id to check on it.`
          : "The process already exited (it did not stay running).";
        const log = out.output.trim()
          ? `Initial output:\n${out.output}`
          : "(no output yet)";
        return truncate(`${status}\n${log}`);
      }
      case "read_output": {
        const out = await readOutput(String(args.id ?? ""));
        const status = out.running
          ? "The process is still running."
          : "The process is no longer running (it exited or was stopped).";
        const log = out.output.trim() ? `Output:\n${out.output}` : "(no output)";
        return truncate(`${status}\n${log}`);
      }
      case "read_file": {
        const text = await readFile(resolvePath(opts.cwd, String(args.path ?? "")));
        return truncate(text);
      }
      case "write_file": {
        await writeFile(
          resolvePath(opts.cwd, String(args.path ?? "")),
          String(args.contents ?? ""),
        );
        return "File written successfully.";
      }
      case "edit_file": {
        const path = resolvePath(opts.cwd, String(args.path ?? ""));
        const oldStr = String(args.old_string ?? "");
        const newStr = String(args.new_string ?? "");
        const replaceAll = Boolean(args.replace_all);
        if (!oldStr) return "Error: 'old_string' is required and must be non-empty.";
        if (oldStr === newStr) return "Error: 'old_string' and 'new_string' are identical; nothing to change.";
        let text: string;
        try {
          text = await readFile(path);
        } catch (e) {
          return `Error: could not read ${path}: ${String(e)}`;
        }
        // Count occurrences without regex so special characters are literal.
        const count = text.split(oldStr).length - 1;
        if (count === 0)
          return `Error: 'old_string' was not found in ${path}. Read the file first and copy the exact text (including indentation).`;
        if (count > 1 && !replaceAll)
          return `Error: 'old_string' appears ${count} times in ${path}. Add surrounding context to make it unique, or set replace_all=true to change every occurrence.`;
        const updated = replaceAll
          ? text.split(oldStr).join(newStr)
          : text.replace(oldStr, newStr);
        await writeFile(path, updated);
        const n = replaceAll ? count : 1;
        return `Edited ${path} (${n} replacement${n > 1 ? "s" : ""}).`;
      }
      case "list_dir": {
        const entries = await listDir(resolvePath(opts.cwd, String(args.path ?? "")));
        return truncate(
          entries.map((e) => (e.is_dir ? `${e.name}/` : e.name)).join("\n") ||
            "(empty)",
        );
      }
      case "read_terminal": {
        const n = Number(args.lines);
        const text = opts.readTerminal?.(Number.isFinite(n) && n > 0 ? n : undefined) ?? null;
        if (text == null) return "No active terminal is available.";
        const trimmed = text.trim();
        return trimmed ? truncate(trimmed) : "(the terminal is currently empty)";
      }
      case "list_agents": {
        const peers = opts.peers?.() ?? [];
        const lines: string[] = [];
        if (opts.self) lines.push(`You are: ${opts.self.name} (id: ${opts.self.id})`);
        if (peers.length === 0) {
          lines.push("No other agents are currently active.");
        } else {
          lines.push("Other agents:");
          for (const p of peers)
            lines.push(`- ${p.name} (id: ${p.id}) — ${p.status}${p.task ? `: ${p.task}` : ""}`);
        }
        return lines.join("\n");
      }
      case "send_message": {
        const to = String(args.to ?? "");
        const message = String(args.message ?? "");
        if (!to || !message) return "Error: both 'to' and 'message' are required.";
        const ok = opts.sendMessage?.(to, message) ?? false;
        return ok
          ? `Message delivered to ${to}.`
          : `Error: no active agent matches "${to}". Use list_agents to see valid names/ids.`;
      }
      case "spawn_agent": {
        const name = String(args.name ?? "");
        const task = String(args.task ?? "");
        if (!task) return "Error: 'task' is required.";
        const created = opts.spawnAgent?.(name, task) ?? null;
        return created
          ? `Spawned agent "${created}". It is now working on the task; use send_message to coordinate.`
          : "Error: could not spawn a new agent.";
      }
      default:
        return `Unknown tool: ${call.name}`;
    }
  } catch (e) {
    return `Error: ${String(e)}`;
  }
}

/**
 * Run the agent until it produces a final answer (no tool calls) or hits a
 * limit. `history` is the full prior conversation; returns the extended
 * conversation including all assistant/tool messages produced this run.
 */
export async function runAgent(
  history: ChatMessage[],
  opts: AgentOptions,
  cb: AgentCallbacks,
): Promise<ChatMessage[]> {
  const messages = [...history];
  const system = systemPrompt(opts);
  /** True once the model answers with no further tool calls (or errors out). */
  let completed = false;
  // Offer the A2A tools only to agents that have an identity (multi-agent runs).
  const tools = opts.self ? [...TOOLS, ...A2A_TOOLS] : TOOLS;
  // System prompt + tool schemas are constant across the loop; price them once
  // so the per-step compaction budget only has to weigh the moving transcript.
  const budget = opts.maxContextTokens ?? DEFAULT_CONTEXT_TOKENS;
  const fixedOverhead =
    estimateTokens(system) + estimateTokens(JSON.stringify(tools)) + 8;
  const stepLimit = opts.maxSteps && opts.maxSteps > 0 ? opts.maxSteps : MAX_STEPS;

  for (let step = 0; step < stepLimit; step++) {
    if (opts.shouldStop()) break;

    // Deliver any peer messages that arrived since the last step so a running
    // agent sees them mid-task (an idle agent is restarted by the manager).
    const inbox = opts.drainInbox?.() ?? [];
    for (const msg of inbox) {
      messages.push({
        role: "user",
        content: `[Message from ${msg.from}]\n${msg.text}`,
      });
      cb.onNote?.(msg.from, msg.text);
    }

    let text = "";
    const toolCalls: ToolCall[] = [];
    let finish = "stop";

    cb.onAssistantStart();
    const sid = streamId();
    cb.onStream?.(sid);
    // Compact the model-facing copy only; `messages` (and the displayed history)
    // stay full so the user still sees everything the agent did.
    const { messages: wire, info } = compactForModel(messages, fixedOverhead, budget);
    // As the step budget runs low, nudge the model to conclude on its own so it
    // wraps up cleanly rather than getting cut off mid-action. The reminder is
    // added only to the model-facing copy, never persisted to the transcript.
    const stepsLeft = stepLimit - step;
    if (stepsLeft <= WRAP_UP_WINDOW) {
      wire.push({
        role: "user",
        content:
          `[System notice: you have ${stepsLeft} tool step${stepsLeft === 1 ? "" : "s"} left before this run pauses. ` +
          `Prioritize finishing the task now. If it can't be completed in time, stop calling tools and reply with a short summary of what you did and the exact next step to resume.]`,
      });
    }
    if (info.compacted) {
      console.log(
        `[agent] step ${step}: compacted ~${info.beforeTokens}→~${info.afterTokens} tok (elided ${info.elidedTools} tools, dropped ${info.droppedMessages} msgs)`,
      );
      cb.onCompact?.(info);
    }
    console.log(`[agent] step ${step}: streaming (sid=${sid})`);
    await streamChat(
      opts.provider,
      system,
      wire,
      tools,
      (ev) => {
        if (ev.type === "text") {
          text += ev.value;
          cb.onText(ev.value);
        } else if (ev.type === "tool_call") {
          const call = { id: ev.id, name: ev.name, arguments: ev.arguments };
          cb.onToolCall(call);
          // Codex runs its own tools — show the card, but never execute it
          // ourselves (only queue tool calls we own for execution).
          if (opts.provider.kind !== "codex") toolCalls.push(call);
        } else if (ev.type === "tool_result") {
          cb.onToolResult(ev.id, ev.result);
        } else if (ev.type === "done") {
          finish = ev.finish;
        } else if (ev.type === "error") {
          finish = "error";
          cb.onError(ev.message);
        }
      },
      sid,
      opts.cwd,
    );
    cb.onStream?.(null);
    console.log(
      `[agent] step ${step}: stream done (finish=${finish}, tools=${toolCalls.length}, stop=${opts.shouldStop()})`,
    );

    messages.push({
      role: "assistant",
      content: text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });

    // Stop pressed during/after the stream: do NOT execute any tool calls the
    // (possibly cancelled) turn accumulated — that can re-enter approval and
    // wedge the loop. Bail now.
    if (opts.shouldStop()) break;
    if (finish === "error" || toolCalls.length === 0) {
      completed = true;
      break;
    }

    // Execute this turn's tools. Read-only calls run concurrently (they never
    // prompt for approval, so they can't collide on the single approval slot);
    // everything else runs sequentially so writes/commands stay ordered and
    // approvals are requested one at a time. Results are recorded by id and
    // appended in the model's original call order so the transcript reads
    // naturally regardless of completion order.
    const results = new Map<string, string>();
    const runOne = async (call: ToolCall) => {
      const result = opts.shouldStop()
        ? "Stopped by the user."
        : await executeTool(call, opts, cb);
      results.set(call.id, result);
      cb.onToolResult(call.id, result);
    };

    const parallel = toolCalls.filter((c) => READ_ONLY.has(c.name));
    const serial = toolCalls.filter((c) => !READ_ONLY.has(c.name));
    if (parallel.length) await Promise.all(parallel.map(runOne));
    for (const call of serial) await runOne(call);

    for (const call of toolCalls) {
      messages.push({
        role: "tool",
        content: results.get(call.id) ?? "Stopped by the user.",
        toolCallId: call.id,
      });
    }
  }
  console.log("[agent] loop exited");

  // Ran out of steps while the model still wanted to use tools: tell the user,
  // since otherwise the agent just stops mid-task with no explanation.
  if (!completed && !opts.shouldStop()) {
    cb.onInfo?.(
      `Paused after ${stepLimit} steps to avoid running away. Press Continue to keep going, or raise the step limit in AI settings.`,
    );
    cb.onPaused?.();
  }

  return messages;
}
