/** Context compaction for the agent loop.
 *
 *  An agent re-sends its whole growing transcript on every step, so cost grows
 *  roughly quadratically with the number of steps — and the biggest sink is
 *  large, stale tool outputs (a 12 KB file read re-sent on all 16 steps). This
 *  module produces a *model-facing* copy of the conversation that fits a token
 *  budget, while the real `history` (shown to the user and persisted) stays
 *  intact.
 *
 *  Strategy, cheapest first (no extra model call):
 *   1. Keep the first message (the task) and the last few turn-groups verbatim —
 *      recent context matters most and a stable head keeps prompt caches warm.
 *   2. In the middle, elide long tool outputs and old reasoning to short stubs.
 *   3. If still over budget, drop whole oldest turn-groups and replace them with
 *      a single breadcrumb note listing what happened, so the model keeps the
 *      gist without the bytes.
 *
 *  Compaction always operates on whole *turn-groups* (an assistant message plus
 *  the tool messages answering it), so an assistant `tool_calls` is never left
 *  without its matching `tool` results — which providers reject. */
import type { ChatMessage } from "./types";

/** Rough token estimate. ~4 chars/token is close enough for budgeting. */
const CHARS_PER_TOKEN = 4;
/** Turn-groups (besides the task) always kept verbatim at the tail. */
const KEEP_RECENT_GROUPS = 3;
/** Chars retained from the head of an elided tool result. */
const TOOL_ELIDE_KEEP = 280;
/** Chars retained from the head of an elided assistant message. */
const ASSISTANT_ELIDE_KEEP = 360;
/** Default budget when none is configured. */
export const DEFAULT_CONTEXT_TOKENS = 16_000;

export function estimateTokens(s: string): number {
  return Math.ceil((s?.length ?? 0) / CHARS_PER_TOKEN);
}

function messageTokens(m: ChatMessage): number {
  let t = 4 + estimateTokens(m.content); // ~4 tokens role/format overhead
  for (const c of m.toolCalls ?? [])
    t += 4 + estimateTokens(c.name) + estimateTokens(c.arguments);
  if (m.toolCallId) t += 2;
  return t;
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((n, m) => n + messageTokens(m), 0);
}

export interface CompactInfo {
  compacted: boolean;
  beforeTokens: number;
  afterTokens: number;
  /** How many tool outputs were shortened in place. */
  elidedTools: number;
  /** How many whole messages were dropped into the summary breadcrumb. */
  droppedMessages: number;
}

/** Split a transcript into turn-groups. A group starts at a user or assistant
 *  message; `tool` messages attach to the group they answer. This keeps an
 *  assistant `tool_calls` and its `tool` results inseparable. */
function buildGroups(messages: ChatMessage[]): ChatMessage[][] {
  const groups: ChatMessage[][] = [];
  for (const m of messages) {
    if (m.role === "tool" && groups.length) {
      groups[groups.length - 1].push(m);
    } else {
      groups.push([m]);
    }
  }
  return groups;
}

/** Shorten long tool/assistant content in a group; tool *structure* is kept. */
function elideGroup(group: ChatMessage[]): ChatMessage[] {
  return group.map((m) => {
    if (m.role === "tool" && m.content.length > TOOL_ELIDE_KEEP + 40) {
      return {
        ...m,
        content:
          m.content.slice(0, TOOL_ELIDE_KEEP) +
          `\n…[${m.content.length - TOOL_ELIDE_KEEP} chars elided to save context]`,
      };
    }
    if (m.role === "assistant" && m.content.length > ASSISTANT_ELIDE_KEEP + 40) {
      return { ...m, content: m.content.slice(0, ASSISTANT_ELIDE_KEEP) + " …[elided]" };
    }
    return m;
  });
}

/** A breadcrumb describing dropped groups: which tools ran, roughly. */
function summaryNote(droppedGroups: ChatMessage[][]): string {
  const calls: string[] = [];
  for (const g of droppedGroups)
    for (const m of g)
      for (const c of m.toolCalls ?? []) {
        let arg = "";
        try {
          const a = JSON.parse(c.arguments || "{}") as Record<string, unknown>;
          arg = String(a.command ?? a.path ?? a.task ?? a.to ?? "");
        } catch {
          /* ignore */
        }
        calls.push(arg ? `${c.name}(${arg.slice(0, 60)})` : c.name);
      }
  const list = calls.length
    ? calls.slice(0, 12).join(", ") +
      (calls.length > 12 ? `, +${calls.length - 12} more` : "")
    : "intermediate reasoning and results";
  const n = droppedGroups.reduce((x, g) => x + g.length, 0);
  return `[Context summary: ${n} earlier messages were elided to save tokens. Earlier work included: ${list}. The original task and the most recent steps are preserved below.]`;
}

/**
 * Build a model-facing transcript that fits `maxTokens` (messages + the given
 * `fixedOverhead` for the system prompt and tool schemas). Returns the original
 * array unchanged when already within budget — preserving prompt-cache hits and
 * avoiding needless allocation.
 */
export function compactForModel(
  messages: ChatMessage[],
  fixedOverhead: number,
  maxTokens: number,
): { messages: ChatMessage[]; info: CompactInfo } {
  const before = fixedOverhead + estimateMessagesTokens(messages);
  const noop = (): { messages: ChatMessage[]; info: CompactInfo } => ({
    messages,
    info: {
      compacted: false,
      beforeTokens: before,
      afterTokens: before,
      elidedTools: 0,
      droppedMessages: 0,
    },
  });

  if (maxTokens <= 0 || before <= maxTokens) return noop();

  const groups = buildGroups(messages);
  const headCount = 1; // the task
  const tailCount = Math.min(
    KEEP_RECENT_GROUPS,
    Math.max(0, groups.length - headCount),
  );
  const midStart = headCount;
  const midEnd = groups.length - tailCount;
  if (midEnd <= midStart) return noop(); // nothing in the middle to compact

  const head = groups.slice(0, headCount).flat();
  const tail = groups.slice(midEnd).flat();
  const midGroups = groups.slice(midStart, midEnd);

  // Phase 1 — elide the middle in place.
  let elidedTools = 0;
  const elidedGroups = midGroups.map((g) => {
    const out = elideGroup(g);
    elidedTools += out.filter(
      (m, i) => m.role === "tool" && m.content !== g[i].content,
    ).length;
    return out;
  });

  let assembled = [...head, ...elidedGroups.flat(), ...tail];
  let after = fixedOverhead + estimateMessagesTokens(assembled);
  let droppedMessages = 0;

  // Phase 2 — still over budget: drop whole oldest middle groups, replacing the
  // dropped span with one breadcrumb note.
  if (after > maxTokens) {
    let drop = 1;
    for (; drop <= elidedGroups.length; drop++) {
      const note: ChatMessage = {
        role: "user",
        content: summaryNote(midGroups.slice(0, drop)),
      };
      const remaining = elidedGroups.slice(drop).flat();
      const candidate = [...head, note, ...remaining, ...tail];
      const tok = fixedOverhead + estimateMessagesTokens(candidate);
      if (tok <= maxTokens || drop === elidedGroups.length) {
        assembled = candidate;
        after = tok;
        droppedMessages = midGroups
          .slice(0, drop)
          .reduce((x, g) => x + g.length, 0);
        break;
      }
    }
  }

  return {
    messages: assembled,
    info: {
      compacted: true,
      beforeTokens: before,
      afterTokens: after,
      elidedTools,
      droppedMessages,
    },
  };
}
