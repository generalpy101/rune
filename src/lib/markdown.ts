/** Markdown → safe HTML for AI assistant messages.
 *
 *  We render finished assistant turns as Markdown, but the content comes from a
 *  model the user pointed us at, and this webview can call Tauri IPC — so raw
 *  model output is untrusted. Everything is sanitized with DOMPurify before it
 *  reaches the DOM (no scripts, no event handlers, no `javascript:` URLs).
 *
 *  Performance note: the old approach re-rendered a large React element tree
 *  synchronously when a turn finished, freezing the shared webview thread (and
 *  the terminal with it). This instead produces an HTML *string* that the
 *  browser parses natively in one `innerHTML` assignment — far cheaper than
 *  React reconciliation — and the caller memoizes it so each message is parsed
 *  exactly once, never per render and never per streamed token. */
import { marked } from "marked";
import DOMPurify, { type Config } from "dompurify";

marked.setOptions({
  gfm: true,
  breaks: true,
});

/** Tags/attrs beyond DOMPurify's defaults that we explicitly want to keep. */
const SANITIZE_CONFIG: Config = {
  ADD_ATTR: ["target", "rel"],
};

// Force every link to open in the user's real browser (handled by the click
// interceptor in the panel) and never carry a referrer.
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "A") {
    node.setAttribute("target", "_blank");
    node.setAttribute("rel", "noopener noreferrer");
  }
});

/** Parse Markdown to sanitized HTML. Synchronous and side-effect free. */
export function renderMarkdown(src: string): string {
  const raw = marked.parse(src ?? "", { async: false }) as string;
  return DOMPurify.sanitize(raw, SANITIZE_CONFIG) as unknown as string;
}
