import type { Extension } from "@codemirror/state";
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

/** Pick a CodeMirror language extension for a filename, or none. */
export function langForFile(name: string): Extension[] {
  const lower = name.toLowerCase();
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ts":
    case "mts":
    case "cts":
      return [javascript({ typescript: true })];
    case "tsx":
      return [javascript({ typescript: true, jsx: true })];
    case "js":
    case "mjs":
    case "cjs":
      return [javascript()];
    case "jsx":
      return [javascript({ jsx: true })];
    case "rs":
      return [rust()];
    case "py":
    case "pyw":
      return [python()];
    case "json":
    case "jsonc":
      return [json()];
    case "html":
    case "htm":
    case "vue":
    case "svelte":
      return [html()];
    case "css":
    case "scss":
    case "sass":
    case "less":
      return [css()];
    case "md":
    case "markdown":
    case "mdx":
      return [markdown()];
    case "c":
    case "h":
    case "cpp":
    case "cc":
    case "cxx":
    case "hpp":
      return [cpp()];
    case "java":
      return [java()];
    case "php":
      return [php()];
    case "sql":
      return [sql()];
    case "xml":
    case "svg":
      return [xml()];
    case "yaml":
    case "yml":
      return [yaml()];
    case "go":
      return [go()];
    default:
      return [];
  }
}
