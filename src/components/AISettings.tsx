import { useEffect, useRef, useState } from "react";
import {
  type AiConfig,
  type ProviderConfig,
  activeProvider,
} from "../lib/ai/config";
import { listModels } from "../lib/ai/client";

interface Props {
  config: AiConfig;
  onChange: (config: AiConfig) => void;
  onClose: () => void;
}

/** Connection probe state for the active provider. */
type Probe =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok"; models: string[] }
  | { state: "error"; message: string };

/** Settings modal: enable the agent, pick/edit a provider, bring your own key,
 *  and — crucially for local servers like Ollama — auto-discover the available
 *  models so you can tell whether the model name you typed actually exists. */
export function AISettings({ config, onChange, onClose }: Props) {
  const provider = activeProvider(config);
  const [probe, setProbe] = useState<Probe>({ state: "idle" });
  // Bumped to force a re-probe (e.g. the manual "Test connection" button).
  const [probeNonce, setProbeNonce] = useState(0);

  const updateProvider = (patch: Partial<ProviderConfig>) => {
    if (!provider) return;
    onChange({
      ...config,
      providers: config.providers.map((p) =>
        p.id === provider.id ? { ...p, ...patch } : p,
      ),
    });
  };

  const isLocal =
    provider != null && /localhost|127\.0\.0\.1/.test(provider.baseUrl);

  // Auto-probe the provider whenever its connection details change (debounced).
  // Local servers need no key; remote ones wait until a key is entered.
  const baseUrl = provider?.baseUrl ?? "";
  const apiKey = provider?.apiKey ?? "";
  const providerId = provider?.id ?? "";
  const lastReq = useRef(0);

  useEffect(() => {
    if (!provider) {
      setProbe({ state: "idle" });
      return;
    }
    if (!isLocal && !apiKey.trim()) {
      setProbe({ state: "idle" });
      return;
    }
    let cancelled = false;
    const req = ++lastReq.current;
    setProbe({ state: "checking" });
    const timer = setTimeout(async () => {
      try {
        const list = await listModels(baseUrl, apiKey);
        if (cancelled || req !== lastReq.current) return;
        setProbe({ state: "ok", models: list });
      } catch (e) {
        if (cancelled || req !== lastReq.current) return;
        setProbe({ state: "error", message: friendlyError(String(e), baseUrl) });
      }
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, baseUrl, apiKey, isLocal, probeNonce]);

  const models = probe.state === "ok" ? probe.models : [];
  const model = provider?.model.trim() ?? "";
  const modelKnown = models.includes(model);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal ai-settings" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-msg">AI Assistant</div>

        <label className="setting-row">
          <span>Enable AI</span>
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => onChange({ ...config, enabled: e.target.checked })}
          />
        </label>

        <label className="setting-row">
          <span>Provider</span>
          <select
            value={config.activeProviderId ?? ""}
            onChange={(e) =>
              onChange({ ...config, activeProviderId: e.target.value || null })
            }
          >
            <option value="">Select…</option>
            {config.providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>

        {provider && (
          <>
            {!provider.preset && (
              <label className="setting-row">
                <span>Base URL</span>
                <input
                  type="text"
                  value={provider.baseUrl}
                  onChange={(e) => updateProvider({ baseUrl: e.target.value })}
                />
              </label>
            )}

            <label className="setting-row">
              <span>API key</span>
              <input
                type="password"
                placeholder={isLocal ? "(not required)" : "sk-…"}
                value={provider.apiKey}
                onChange={(e) => updateProvider({ apiKey: e.target.value })}
              />
            </label>

            {/* Connection status — tells you at a glance whether the server is
                reachable, before you even pick a model. */}
            <div className={`ai-conn ai-conn-${probe.state}`}>
              <span className="ai-conn-dot" />
              <span className="ai-conn-text">
                {probe.state === "idle" &&
                  (isLocal
                    ? "Enter the base URL to check the connection."
                    : "Enter an API key to check the connection.")}
                {probe.state === "checking" && "Connecting…"}
                {probe.state === "ok" &&
                  `Connected — ${probe.models.length} model${
                    probe.models.length === 1 ? "" : "s"
                  } available`}
                {probe.state === "error" && probe.message}
              </span>
              <button
                className="ai-conn-retry"
                title="Test connection again"
                onClick={() => setProbeNonce((n) => n + 1)}
              >
                Test
              </button>
            </div>

            <label className="setting-row">
              <span>Model</span>
              <input
                type="text"
                list="ai-model-list"
                placeholder={isLocal ? "e.g. llama3.1" : "model id"}
                value={provider.model}
                onChange={(e) => updateProvider({ model: e.target.value })}
              />
              <datalist id="ai-model-list">
                {models.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </label>

            {/* Model validity: the whole point — does the name you typed exist? */}
            {model !== "" && probe.state === "ok" && (
              <div
                className={`ai-model-status ${
                  modelKnown ? "ai-ok" : "ai-warn"
                }`}
              >
                {modelKnown
                  ? `✓ "${model}" is available on this server.`
                  : `⚠ "${model}" was not found on this server. Pick one below` +
                    (isLocal ? " (or run `ollama pull " + model + "`)." : ".")}
              </div>
            )}

            {models.length > 0 && (
              <div className="ai-model-chips">
                {models.map((m) => (
                  <button
                    key={m}
                    className={`ai-model-chip${m === model ? " active" : ""}`}
                    onClick={() => updateProvider({ model: m })}
                    title="Use this model"
                  >
                    {m}
                  </button>
                ))}
              </div>
            )}

            <label className="setting-row">
              <span>Auto-approve commands</span>
              <input
                type="checkbox"
                checked={config.autoApprove}
                onChange={(e) =>
                  onChange({ ...config, autoApprove: e.target.checked })
                }
              />
            </label>
            <p className="ai-hint">
              When off, the agent asks before running shell commands or writing
              files. Keys are stored only on this machine.
            </p>

            <label className="setting-row">
              <span>Compact context</span>
              <input
                type="checkbox"
                checked={config.autoCompact}
                onChange={(e) =>
                  onChange({ ...config, autoCompact: e.target.checked })
                }
              />
            </label>
            {config.autoCompact && (
              <label className="setting-row">
                <span>Context budget (tokens)</span>
                <input
                  type="number"
                  min={2000}
                  step={1000}
                  value={config.maxContextTokens}
                  onChange={(e) =>
                    onChange({
                      ...config,
                      maxContextTokens: Math.max(
                        2000,
                        Number(e.target.value) || 0,
                      ),
                    })
                  }
                />
              </label>
            )}
            <p className="ai-hint">
              Trims old tool output sent to the model once it passes the budget,
              cutting token cost. Your on-screen transcript stays complete.
            </p>

            <label className="setting-row">
              <span>Max steps per run</span>
              <input
                type="number"
                min={5}
                step={5}
                value={config.maxSteps}
                onChange={(e) =>
                  onChange({
                    ...config,
                    maxSteps: Math.max(5, Number(e.target.value) || 0),
                  })
                }
              />
            </label>
            <p className="ai-hint">
              How many tool steps the agent may take before it pauses. It's
              nudged to wrap up as it nears the limit; raise this for bigger
              tasks, lower it to cap runaway cost.
            </p>
          </>
        )}

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** Turn a raw invoke/HTTP error into something a user can act on. */
function friendlyError(raw: string, baseUrl: string): string {
  const e = raw.toLowerCase();
  if (e.includes("connection refused") || e.includes("tcp connect")) {
    return `Can't reach ${baseUrl}. Is the server running?`;
  }
  if (e.includes("http 401") || e.includes("http 403")) {
    return "Authentication failed — check your API key.";
  }
  if (e.includes("http 404")) {
    return "Endpoint not found — check the base URL.";
  }
  if (e.includes("dns") || e.includes("resolve")) {
    return `Couldn't resolve the host in ${baseUrl}.`;
  }
  return raw.replace(/^Error:\s*/i, "");
}
