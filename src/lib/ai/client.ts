/** Thin glue to the Rust AI commands. */
import { invoke, Channel } from "@tauri-apps/api/core";
import type { AiEvent, ChatMessage, ToolDef } from "./types";
import type { ProviderConfig } from "./config";

export interface CommandOutput {
  stdout: string;
  stderr: string;
  code: number | null;
  /** True when Stop/timeout killed the command rather than it exiting itself. */
  killed: boolean;
}

/** A command the agent is currently running (for the activity monitor). */
export interface RunningCommand {
  id: string;
  command: string;
  cwd: string;
  /** Epoch milliseconds when the command started. */
  started: number;
  /** True for long-running background processes (dev servers, watchers). */
  background: boolean;
}

/** Snapshot of a background process: its captured log and liveness. */
export interface BackgroundOutput {
  id: string;
  output: string;
  running: boolean;
}

/** Run a command, tracked by `id` so it can be stopped mid-flight. */
export const runCommand = (
  cwd: string,
  command: string,
  id: string,
  timeoutMs?: number,
) =>
  invoke<CommandOutput>("run_command", {
    cwd,
    command,
    id,
    timeoutMs: timeoutMs ?? null,
  });

/**
 * Start a long-running background process (dev server, watcher). Returns after
 * a short grace period with the initial output — the process keeps running.
 */
export const runBackground = (
  cwd: string,
  command: string,
  id: string,
  graceMs?: number,
) =>
  invoke<BackgroundOutput>("run_background", {
    cwd,
    command,
    id,
    graceMs: graceMs ?? null,
  });

/** Poll a background process's captured output and whether it's still running. */
export const readOutput = (id: string) =>
  invoke<BackgroundOutput>("command_output", { id });

/** Kill a single running command (and its whole process tree). */
export const cancelCommand = (id: string) =>
  invoke<boolean>("cancel_command", { id });

/** Kill every running agent command. Returns how many were signalled. */
export const cancelAllCommands = () =>
  invoke<number>("cancel_all_commands");

/** Snapshot of all commands the agent is currently running. */
export const listRunningCommands = () =>
  invoke<RunningCommand[]>("list_running_commands");

export const listModels = (baseUrl: string, apiKey: string) =>
  invoke<string[]>("ai_list_models", { baseUrl, apiKey });

/** The snake_case payload the Rust `ai_chat` command deserializes. */
interface WireRequest {
  kind: string;
  base_url: string;
  api_key: string;
  model: string;
  system?: string;
  messages: {
    role: string;
    content: string;
    tool_calls: { id: string; name: string; arguments: string }[];
    tool_call_id?: string;
  }[];
  tools: ToolDef[];
  temperature?: number;
  max_tokens?: number;
  /** Per-turn id so the stream can be cancelled via `cancelChat`. */
  id: string;
  /** Working directory — used by the `codex` kind to run `codex exec` there. */
  cwd?: string;
}

/** Cancel an in-flight model stream (Stop). */
export const cancelChat = (id: string) =>
  invoke<boolean>("cancel_chat", { id });

function toWire(
  provider: ProviderConfig,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  id: string,
  cwd: string,
): WireRequest {
  return {
    kind: provider.kind,
    base_url: provider.baseUrl,
    api_key: provider.apiKey,
    model: provider.model,
    system,
    id,
    cwd,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
      tool_calls: (m.toolCalls ?? []).map((c) => ({
        id: c.id,
        name: c.name,
        arguments: c.arguments,
      })),
      tool_call_id: m.toolCallId,
    })),
    tools,
    temperature: 0,
  };
}

/**
 * Stream one model turn. Resolves once the backend signals `done` (or `error`,
 * which is surfaced through `onEvent` first). Rejects only if the command
 * itself fails to dispatch.
 */
export function streamChat(
  provider: ProviderConfig,
  system: string,
  messages: ChatMessage[],
  tools: ToolDef[],
  onEvent: (ev: AiEvent) => void,
  streamId: string,
  cwd: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new Channel<AiEvent>();
    channel.onmessage = (ev) => {
      onEvent(ev);
      if (ev.type === "done" || ev.type === "error") resolve();
    };
    invoke("ai_chat", {
      req: toWire(provider, system, messages, tools, streamId, cwd),
      onEvent: channel,
    }).catch(reject);
  });
}
