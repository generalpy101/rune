import type { Extension } from "@codemirror/state";
import { StreamLanguage } from "@codemirror/language";
import { javascript } from "@codemirror/lang-javascript";
import { rust } from "@codemirror/lang-rust";
import { python } from "@codemirror/lang-python";
import { json } from "@codemirror/lang-json";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { markdown } from "@codemirror/lang-markdown";
import { cpp } from "@codemirror/lang-cpp";
import { java } from "@codemirror/lang-java";
import { php } from "@codemirror/lang-php";
import { sql } from "@codemirror/lang-sql";
import { xml } from "@codemirror/lang-xml";
import { yaml } from "@codemirror/lang-yaml";
import { go } from "@codemirror/lang-go";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { lua } from "@codemirror/legacy-modes/mode/lua";

/**
 * Canonical language key for a filename. The single source of truth used by the
 * editor extension picker, the status-bar label, and the completion registry.
 * To support a new language, add a case here and a matching entry in `langForFile`
 * / `LABELS` (and optionally `KEYWORDS` in cmComplete.ts). Returns "" for unknown.
 */
export function langKeyForFile(name: string): string {
  const lower = name.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  // Extension-less / by-name files first.
  if (base === "dockerfile" || base.endsWith(".dockerfile")) return "dockerfile";
  if (base === "makefile" || base === "gnumakefile") return "makefile";
  if (base === "cargo.lock") return "toml";

  const ext = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return "ts";
    case "tsx":
      return "tsx";
    case "js":
    case "mjs":
    case "cjs":
      return "js";
    case "jsx":
      return "jsx";
    case "rs":
      return "rust";
    case "py":
    case "pyw":
      return "py";
    case "json":
    case "jsonc":
      return "json";
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return "html";
    case "css":
    case "scss":
    case "sass":
    case "less":
      return "css";
    case "md":
    case "markdown":
    case "mdx":
      return "markdown";
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return "cpp";
    case "java":
      return "java";
    case "php":
      return "php";
    case "sql":
      return "sql";
    case "xml":
    case "svg":
      return "xml";
    case "yaml":
    case "yml":
      return "yaml";
    case "go":
      return "go";
    case "toml":
      return "toml";
    case "sh":
    case "bash":
    case "zsh":
    case "fish":
      return "shell";
    case "rb":
      return "ruby";
    case "lua":
      return "lua";
    default:
      return "";
  }
}

/** Pick a CodeMirror language extension for a filename, or none. */
export function langForFile(name: string): Extension[] {
  switch (langKeyForFile(name)) {
    case "ts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "rust":
      return [rust()];
    case "py":
      return [python()];
    case "json":
      return [json()];
    case "html":
      return [html()];
    case "css":
      return [css()];
    case "markdown":
      return [markdown()];
    case "cpp":
      return [cpp()];
    case "java":
      return [java()];
    case "php":
      return [php()];
    case "sql":
      return [sql()];
    case "xml":
      return [xml()];
    case "yaml":
      return [yaml()];
    case "go":
      return [go()];
    case "toml":
      return [StreamLanguage.define(toml)];
    case "shell":
      return [StreamLanguage.define(shell)];
    case "ruby":
      return [StreamLanguage.define(ruby)];
    case "lua":
      return [StreamLanguage.define(lua)];
    case "dockerfile":
      return [StreamLanguage.define(dockerFile)];
    default:
      return [];
  }
}

const LABELS: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript JSX",
  js: "JavaScript",
  jsx: "JavaScript JSX",
  rust: "Rust",
  py: "Python",
  json: "JSON",
  html: "HTML",
  css: "CSS",
  markdown: "Markdown",
  cpp: "C/C++",
  java: "Java",
  php: "PHP",
  sql: "SQL",
  xml: "XML",
  yaml: "YAML",
  go: "Go",
  toml: "TOML",
  shell: "Shell",
  ruby: "Ruby",
  lua: "Lua",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
};

/** Human-readable language label for the editor status bar. */
export function langLabel(key: string): string {
  return LABELS[key] ?? "Plain Text";
}
