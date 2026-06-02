import { invoke } from "@tauri-apps/api/core";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const listDir = (path: string) =>
  invoke<DirEntry[]>("list_dir", { path });

export const readFile = (path: string) =>
  invoke<string>("read_file", { path });

export const writeFile = (path: string, contents: string) =>
  invoke("write_file", { path, contents });

export const createFile = (path: string) =>
  invoke("create_file", { path });

export const createDir = (path: string) =>
  invoke("create_dir", { path });

export const renamePath = (from: string, to: string) =>
  invoke("rename_path", { from, to });

export const movePath = (from: string, to: string) =>
  invoke("move_path", { from, to });

export const copyPath = (from: string, to: string) =>
  invoke("copy_path", { from, to });

export const duplicatePath = (path: string) =>
  invoke<string>("duplicate_path", { path });

export const deletePath = (path: string) =>
  invoke("delete_path", { path });

export const homeDir = () => invoke<string>("home_dir");

export const revealInFinder = (path: string) =>
  invoke("reveal_in_finder", { path });

export const walkDir = (root: string) =>
  invoke<string[]>("walk_dir", { root });

export type GitStatus = Record<string, string>;

export const gitStatus = (path: string) =>
  invoke<GitStatus>("git_status", { path });

export const gitBranch = (path: string) =>
  invoke<string | null>("git_branch", { path });

export const notify = (title: string, body: string) =>
  invoke("notify", { title, body });
