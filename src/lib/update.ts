import { invoke } from "@tauri-apps/api/core";

/** Result of querying the update endpoint (mirrors the Rust `UpdateInfo`). */
export interface UpdateInfo {
  available: boolean;
  version: string | null;
  notes: string | null;
}

/** Check the configured endpoint for a newer signed release. */
export const checkUpdate = () => invoke<UpdateInfo>("check_update");

/** Download and install the available update (app should restart afterwards). */
export const installUpdate = () => invoke("install_update");
