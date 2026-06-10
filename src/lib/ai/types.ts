/** Shared types for the AI agent: conversation messages, tool calls, and the
 *  streaming events the Rust backend forwards over a Channel. */

export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** JSON-encoded argument object. */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** On assistant messages that invoked tools. */
  toolCalls?: ToolCall[];
  /** On `tool` messages — the call this result answers. */
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  parameters: unknown;
}

/** Normalized streaming event (mirrors the Rust `AiEvent` enum). */
export type AiEvent =
  | { type: "text"; value: string }
  | { type: "tool_call"; id: string; name: string; arguments: string }
  | { type: "tool_result"; id: string; result: string }
  | { type: "done"; finish: string }
  | { type: "error"; message: string };
