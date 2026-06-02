/** Persisted AI chat history. Conversations are stored in localStorage (on this
 *  machine only, alongside the BYO keys) so the panel can be closed/reopened and
 *  the app restarted without losing the transcript. */
import type { ChatMessage } from "./types";

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** The canonical agent history (user/assistant/tool messages). */
  messages: ChatMessage[];
}

const KEY = "rustterm.ai.history";
/** Keep storage bounded; oldest conversations fall off. */
const MAX_CONVERSATIONS = 50;

export function newConversationId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `c${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Derive a short title from the first user message. */
export function deriveTitle(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user");
  const text = first?.content.trim().replace(/\s+/g, " ") ?? "";
  if (!text) return "New chat";
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

export function loadConversations(): Conversation[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Conversation[];
    if (!Array.isArray(parsed)) return [];
    return parsed.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch {
    return [];
  }
}

export function saveConversations(list: Conversation[]): void {
  try {
    const trimmed = [...list]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, MAX_CONVERSATIONS);
    localStorage.setItem(KEY, JSON.stringify(trimmed));
  } catch {
    /* ignore quota errors */
  }
}
