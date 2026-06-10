import { invoke, Channel } from "@tauri-apps/api/core";

/** Overrides for what a terminal runs, from a saved profile. Matches the Rust
 *  `SpawnProfile`. All fields optional; omit for the default login shell. */
export interface SpawnProfile {
  /** Program to launch (path or name on PATH). Omit for the default shell. */
  shell?: string;
  /** Arguments passed to the shell. */
  args?: string[];
  /** Extra environment variables layered on top of the inherited environment. */
  env?: Record<string, string>;
}

/** How to launch an agent CLI (matches the Rust `AgentLaunch`). */
export interface AgentLaunch {
  shell: string;
  args: string[];
}

/** Resolve how to launch an agent CLI (e.g. "codex") through the user's login
 *  shell so its PATH/auth load. Resolves `null` when the CLI isn't installed. */
export const agentSpawn = (command: string) =>
  invoke<AgentLaunch | null>("agent_spawn", { command });

/** Spawn a PTY running the user's shell (or a profile's). Returns the session id. */
export async function spawnPty(
  rows: number,
  cols: number,
  cwd: string | null,
  onData: (chunk: Uint8Array) => void,
  profile?: SpawnProfile | null,
  integration?: boolean,
): Promise<number> {
  const channel = new Channel<string>();
  channel.onmessage = (b64) => onData(base64ToBytes(b64));
  return invoke<number>("pty_spawn", {
    rows,
    cols,
    cwd,
    profile: profile ?? null,
    integration: integration ?? false,
    onData: channel,
  });
}

/** Reattach to a still-running PTY (e.g. after a dev-server reload) instead of
 *  spawning a new shell. Resolves `true` if the session was found and the new
 *  output channel is now live (recent output is replayed first); `false` if the
 *  session is gone and the caller should `spawnPty` fresh. */
export async function attachPty(
  id: number,
  rows: number,
  cols: number,
  onData: (chunk: Uint8Array) => void,
): Promise<boolean> {
  const channel = new Channel<string>();
  channel.onmessage = (b64) => onData(base64ToBytes(b64));
  return invoke<boolean>("pty_attach", { id, rows, cols, onData: channel });
}

export const writePty = (id: number, data: string) =>
  invoke("pty_write", { id, data });

export const resizePty = (id: number, rows: number, cols: number) =>
  invoke("pty_resize", { id, rows, cols });

export const killPty = (id: number) => invoke("pty_kill", { id });

/** Best-effort current working directory of the shell, or null. */
export const ptyCwd = (id: number) => invoke<string | null>("pty_cwd", { id });

/** Whether a foreground command (other than the shell) is currently running. */
export const ptyBusy = (id: number) => invoke<boolean>("pty_busy", { id });

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
