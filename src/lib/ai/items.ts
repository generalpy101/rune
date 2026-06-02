/** Display model for a rendered conversation entry.
 *
 *  The canonical conversation is a `ChatMessage[]`; `Item[]` is the view derived
 *  from it (plus transient UI state like `expanded`). Shared by the AI panel and
 *  the multi-agent manager so both build/render transcripts the same way. */
import type { ChatMessage, ToolCall } from "./types";

export type Item =
  | { kind: "user"; id: number; text: string }
  | { kind: "assistant"; id: number; text: string }
  | { kind: "error"; id: number; text: string }
  /** A subtle system note (e.g. context compaction). Not part of the model
   *  conversation — display only. */
  | { kind: "info"; id: number; text: string }
  /** A note delivered from another agent (A2A inbox). */
  | { kind: "note"; id: number; from: string; text: string }
  | {
      kind: "tool";
      id: string;
      call: ToolCall;
      result?: string;
      awaiting?: boolean;
      approved?: boolean;
      expanded?: boolean;
    };

/** Rebuild display items from a saved transcript. Tool results are reattached
 *  to their originating call by id. */
export function itemsFromMessages(messages: ChatMessage[]): Item[] {
  const items: Item[] = [];
  let n = 0;
  for (const m of messages) {
    if (m.role === "user") {
      items.push({ kind: "user", id: n++, text: m.content });
    } else if (m.role === "assistant") {
      if (m.content.trim())
        items.push({ kind: "assistant", id: n++, text: m.content });
      for (const tc of m.toolCalls ?? [])
        items.push({ kind: "tool", id: tc.id, call: tc });
    } else if (m.role === "tool") {
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (it.kind === "tool" && it.id === m.toolCallId) {
          it.result = m.content;
          break;
        }
      }
    }
  }
  return items;
}
