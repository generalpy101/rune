/** AI configuration: provider presets, bring-your-own keys, and agent options.
 *  Persisted to localStorage. Keys live only on this machine. */

/** Which wire adapter the Rust backend uses for a provider. `codex` is special:
 *  it doesn't talk to an HTTP API — it runs the local Codex CLI (`codex exec`)
 *  under the hood and streams its output, using the CLI's own login/auth. */
export type ProviderKind = "openai" | "anthropic" | "codex";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** API base URL (no trailing slash needed). */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** True for built-in presets (label/kind/baseUrl not user-editable). */
  preset?: boolean;
}

export interface AiConfig {
  enabled: boolean;
  activeProviderId: string | null;
  providers: ProviderConfig[];
  /** Run shell/write tools without asking for approval each time. */
  autoApprove: boolean;
  /** Compact the model-facing transcript when it grows past the budget, to cut
   *  token cost on long agent runs. The displayed transcript stays full. */
  autoCompact: boolean;
  /** Approximate token budget that triggers compaction (system + tools + msgs). */
  maxContextTokens: number;
  /** Max tool-using steps before the run pauses and asks to continue. The agent
   *  is nudged to wrap up as it nears this, so it rarely cuts off mid-action. */
  maxSteps: number;
}

/** Built-in providers. Ollama / LM Studio / OpenRouter / Gemini all speak the
 *  OpenAI-compatible protocol, so they share the `openai` adapter. */
export function presetProviders(): ProviderConfig[] {
  return [
    {
      id: "openai",
      label: "OpenAI",
      kind: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-4o-mini",
      preset: true,
    },
    {
      id: "anthropic",
      label: "Anthropic (Claude)",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "",
      model: "claude-3-5-sonnet-latest",
      preset: true,
    },
    {
      // Runs the local Codex CLI via `codex exec` — uses the CLI's own login,
      // so no API key/model/URL is needed. (`baseUrl: "local"` is just a marker.)
      id: "codex",
      label: "Codex CLI (local)",
      kind: "codex",
      baseUrl: "local",
      apiKey: "",
      model: "",
      preset: true,
    },
    {
      id: "gemini",
      label: "Google Gemini",
      kind: "openai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: "",
      model: "gemini-2.0-flash",
      preset: true,
    },
    {
      id: "ollama",
      label: "Ollama (local)",
      kind: "openai",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "llama3.1",
      preset: true,
    },
  ];
}

export const DEFAULT_AI_CONFIG: AiConfig = {
  enabled: false,
  activeProviderId: null,
  providers: presetProviders(),
  autoApprove: false,
  autoCompact: true,
  maxContextTokens: 16_000,
  maxSteps: 50,
};

const KEY = "rustterm.ai";

export function loadAiConfig(): AiConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<AiConfig>;
      // Merge presets that may have been added in a newer version.
      const byId = new Map(
        (parsed.providers ?? []).map((p) => [p.id, p]),
      );
      for (const preset of presetProviders()) {
        if (!byId.has(preset.id)) byId.set(preset.id, preset);
      }
      return {
        ...DEFAULT_AI_CONFIG,
        ...parsed,
        providers: [...byId.values()],
      };
    }
  } catch {
    /* ignore corrupt config */
  }
  return { ...DEFAULT_AI_CONFIG, providers: presetProviders() };
}

export function saveAiConfig(config: AiConfig): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(config));
  } catch {
    /* ignore quota errors */
  }
}

export function activeProvider(config: AiConfig): ProviderConfig | null {
  return (
    config.providers.find((p) => p.id === config.activeProviderId) ?? null
  );
}

/** Whether the agent is usable: enabled, a provider selected, and (for non-local
 *  providers) an API key present. */
export function aiReady(config: AiConfig): boolean {
  if (!config.enabled) return false;
  const p = activeProvider(config);
  if (!p) return false;
  // Codex uses the local CLI's own auth — no API key/URL required.
  if (p.kind === "codex") return true;
  const isLocal = /localhost|127\.0\.0\.1/.test(p.baseUrl);
  return isLocal || p.apiKey.trim().length > 0;
}
