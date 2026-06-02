/** Glue to the Rust system-monitor commands (`sysmon.rs`). Distinct from the
 *  agent-command registry: these inspect the whole machine so the user can find
 *  and kill stray dev servers / free TCP ports the app never launched. */
import { invoke } from "@tauri-apps/api/core";

/** A process listening on a TCP port. */
export interface PortInfo {
  pid: number;
  /** Command / executable name (e.g. `node`, `Python`). */
  command: string;
  /** Owning user login name. */
  user: string;
  /** Bind address: `*`, `127.0.0.1`, `[::1]`, … */
  address: string;
  port: number;
}

/** Snapshot of every process currently listening on a TCP port. */
export const listListeningPorts = () =>
  invoke<PortInfo[]>("list_listening_ports");

/** Terminate a process by pid (SIGTERM, then SIGKILL backstop) to free its port. */
export const killProcess = (pid: number) =>
  invoke<void>("kill_process", { pid });
