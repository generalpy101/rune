import { useEffect, useRef, useState } from "react";
import {
  resolveTheme,
  themeOptions,
  type Settings,
  type CustomThemeDef,
  type Profile,
  type Snippet,
  type SshHost,
  type UIColors,
} from "../lib/settings";
import { parseThemeText } from "../lib/theme-import";
import { IconClose } from "../lib/icons";

interface Props {
  settings: Settings;
  onChange: (settings: Settings) => void;
  onClose: () => void;
}

type Section = "general" | "themes" | "profiles" | "snippets" | "ssh";

/** Human labels for the editable UI palette slots. */
const UI_FIELDS: [keyof UIColors, string][] = [
  ["bg", "Background"],
  ["panel", "Panel"],
  ["panel2", "Chrome"],
  ["panel3", "Raised"],
  ["border", "Border"],
  ["text", "Text"],
  ["muted", "Muted"],
  ["accent", "Accent"],
  ["accentFg", "Accent text"],
  ["danger", "Danger"],
  ["success", "Success"],
  ["warning", "Warning"],
  ["purple", "Purple"],
];

/** Editable terminal-canvas colors (a subset of xterm's ITheme). */
const TERM_FIELDS: [string, string][] = [
  ["background", "Background"],
  ["foreground", "Foreground"],
  ["cursor", "Cursor"],
  ["selectionBackground", "Selection"],
  ["black", "Black"],
  ["red", "Red"],
  ["green", "Green"],
  ["yellow", "Yellow"],
  ["blue", "Blue"],
  ["magenta", "Magenta"],
  ["cyan", "Cyan"],
  ["white", "White"],
];

const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random()}`;

/** Parse a whitespace-separated argument string into a list. */
const parseArgs = (s: string): string[] =>
  s.split(/\s+/).filter((x) => x.length > 0);

/** Parse `KEY=value` lines into an env map. */
function parseEnv(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    out[t.slice(0, eq).trim()] = t.slice(eq + 1);
  }
  return out;
}

const serializeEnv = (env?: Record<string, string>): string =>
  Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");

export function SettingsModal({ settings, onChange, onClose }: Props) {
  const [section, setSection] = useState<Section>("general");
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="modal settings settings-lg"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="settings-head">
          <div className="modal-msg">Settings</div>
          <div className="settings-tabs">
            {(
              ["general", "themes", "profiles", "snippets", "ssh"] as Section[]
            ).map((s) => (
              <button
                key={s}
                className={section === s ? "active" : ""}
                onClick={() => setSection(s)}
              >
                {s === "ssh" ? "SSH" : s[0].toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="settings-body">
          {section === "general" && (
            <GeneralSection settings={settings} set={set} />
          )}
          {section === "themes" && (
            <ThemesSection settings={settings} onChange={onChange} />
          )}
          {section === "profiles" && (
            <ProfilesSection settings={settings} onChange={onChange} />
          )}
          {section === "snippets" && (
            <SnippetsSection settings={settings} onChange={onChange} />
          )}
          {section === "ssh" && (
            <SshSection settings={settings} onChange={onChange} />
          )}
        </div>

        <div className="modal-actions">
          <button className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────── General ───────────────────────────

function GeneralSection({
  settings,
  set,
}: {
  settings: Settings;
  set: <K extends keyof Settings>(key: K, value: Settings[K]) => void;
}) {
  return (
    <>
      <label className="setting-row">
        <span>Theme</span>
        <select value={settings.theme} onChange={(e) => set("theme", e.target.value)}>
          {themeOptions(settings).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>

      <label className="setting-row">
        <span>Font family</span>
        <input
          type="text"
          value={settings.fontFamily}
          onChange={(e) => set("fontFamily", e.target.value)}
        />
      </label>

      <label className="setting-row">
        <span>Font size</span>
        <input
          type="number"
          min={8}
          max={32}
          value={settings.fontSize}
          onChange={(e) =>
            set("fontSize", Number(e.target.value) || settings.fontSize)
          }
        />
      </label>

      <label className="setting-row">
        <span>Cursor blink</span>
        <input
          type="checkbox"
          checked={settings.cursorBlink}
          onChange={(e) => set("cursorBlink", e.target.checked)}
        />
      </label>

      <div className="theme-group-title">Terminal behavior</div>

      <label className="setting-row">
        <span>Copy on select</span>
        <input
          type="checkbox"
          checked={settings.copyOnSelect}
          onChange={(e) => set("copyOnSelect", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Middle-click paste</span>
        <input
          type="checkbox"
          checked={settings.middleClickPaste}
          onChange={(e) => set("middleClickPaste", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Confirm close when running</span>
        <input
          type="checkbox"
          checked={settings.confirmCloseRunning}
          onChange={(e) => set("confirmCloseRunning", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Notify when a long command finishes</span>
        <input
          type="checkbox"
          checked={settings.notifyOnDone}
          onChange={(e) => set("notifyOnDone", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Shell integration (rt command)</span>
        <input
          type="checkbox"
          checked={settings.shellIntegration}
          onChange={(e) => set("shellIntegration", e.target.checked)}
        />
      </label>
      <p className="ai-hint">
        Injects a small <code>rt</code> function into new terminals so you can
        run app commands inline — e.g. <code>rt snippet build</code>,{" "}
        <code>rt theme dracula</code>, <code>rt split</code>. Type{" "}
        <code>rt help</code> to see them all. POSIX shells (zsh/bash); restart
        terminals after toggling.
      </p>

      <div className="theme-group-title">Appearance</div>

      <label className="setting-row">
        <span>Translucent window (macOS)</span>
        <input
          type="checkbox"
          checked={settings.translucent}
          onChange={(e) => set("translucent", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Show hidden files</span>
        <input
          type="checkbox"
          checked={settings.showHidden}
          onChange={(e) => set("showHidden", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Check for updates on launch</span>
        <input
          type="checkbox"
          checked={settings.autoUpdate}
          onChange={(e) => set("autoUpdate", e.target.checked)}
        />
      </label>

      <div className="theme-group-title">Editor</div>

      <label className="setting-row">
        <span>Autosave</span>
        <input
          type="checkbox"
          checked={settings.autosave}
          onChange={(e) => set("autosave", e.target.checked)}
        />
      </label>

      <label className="setting-row">
        <span>Autosave delay (ms)</span>
        <input
          type="number"
          min={200}
          max={10000}
          step={100}
          disabled={!settings.autosave}
          value={settings.autosaveDelayMs}
          onChange={(e) =>
            set(
              "autosaveDelayMs",
              Number(e.target.value) || settings.autosaveDelayMs,
            )
          }
        />
      </label>
      <label className="setting-row">
        <span>Tidy on save (trim whitespace, final newline)</span>
        <input
          type="checkbox"
          checked={settings.tidyOnSave}
          onChange={(e) => set("tidyOnSave", e.target.checked)}
        />
      </label>
      <p className="ai-hint">
        Saves the open file automatically a short while after you stop typing
        (and on blur / when you switch files). The editor also follows your
        theme and font, and shows the cursor position &amp; language below.
      </p>
    </>
  );
}

// ─────────────────────────── Themes ────────────────────────────

function ThemesSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const custom = settings.customThemes ?? [];
  const editing = custom.find((t) => t.id === editingId) ?? null;

  const addTheme = () => {
    // Seed from the currently active theme so the user tweaks rather than starts blank.
    const base = resolveTheme(settings);
    const theme: CustomThemeDef = {
      id: uid(),
      label: "My Theme",
      dark: base.dark,
      terminal: { ...base.terminal },
      ui: { ...base.ui },
    };
    onChange({ ...settings, customThemes: [...custom, theme], theme: theme.id });
    setEditingId(theme.id);
  };

  const updateTheme = (id: string, patch: Partial<CustomThemeDef>) =>
    onChange({
      ...settings,
      customThemes: custom.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });

  const removeTheme = (id: string) =>
    onChange({
      ...settings,
      customThemes: custom.filter((t) => t.id !== id),
      theme: settings.theme === id ? "mocha" : settings.theme,
    });

  // Parse any supported theme file/text, add it, select it, and start editing.
  const importFrom = (text: string, filename?: string) => {
    setImportErr(null);
    try {
      const parsed = parseThemeText(text, filename);
      const theme: CustomThemeDef = { id: uid(), ...parsed };
      onChange({
        ...settings,
        customThemes: [...custom, theme],
        theme: theme.id,
      });
      setImportText("");
      setEditingId(theme.id);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    }
  };

  const onPickFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    try {
      importFrom(await file.text(), file.name);
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : String(e));
    }
  };

  const exportCurrent = () => {
    const def = resolveTheme(settings);
    const json = JSON.stringify(
      { label: def.label, dark: def.dark, terminal: def.terminal, ui: def.ui },
      null,
      2,
    );
    void navigator.clipboard?.writeText(json);
  };

  return (
    <div className="theme-editor">
      <div className="theme-list">
        {custom.length === 0 && (
          <p className="ai-hint">
            No custom themes yet. Add one (it starts from your current theme), or
            import a <code>.terminal</code>, <code>.itermcolors</code>, Windows
            Terminal, or VS Code theme below.
          </p>
        )}
        {custom.map((t) => (
          <div key={t.id} className="theme-list-row">
            <button
              className={`theme-chip${editingId === t.id ? " active" : ""}`}
              onClick={() => setEditingId(t.id === editingId ? null : t.id)}
            >
              <span
                className="theme-swatch"
                style={{ background: t.ui.accent }}
              />
              {t.label}
            </button>
            <button
              className="icon-btn"
              title="Use this theme"
              onClick={() => onChange({ ...settings, theme: t.id })}
            >
              Use
            </button>
            <button
              className="icon-btn"
              title="Delete theme"
              onClick={() => removeTheme(t.id)}
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
        <div className="theme-actions">
          <button onClick={addTheme}>+ New theme</button>
          <button onClick={exportCurrent} title="Copy current theme JSON to clipboard">
            Export current
          </button>
        </div>
      </div>

      {editing && (
        <div className="theme-fields">
          <label className="setting-row">
            <span>Name</span>
            <input
              type="text"
              value={editing.label}
              onChange={(e) => updateTheme(editing.id, { label: e.target.value })}
            />
          </label>
          <label className="setting-row">
            <span>Dark theme</span>
            <input
              type="checkbox"
              checked={editing.dark}
              onChange={(e) => updateTheme(editing.id, { dark: e.target.checked })}
            />
          </label>

          <div className="theme-group-title">App palette</div>
          <div className="color-grid">
            {UI_FIELDS.map(([key, label]) => (
              <label key={key} className="color-field">
                <input
                  type="color"
                  value={editing.ui[key] || "#000000"}
                  onChange={(e) =>
                    updateTheme(editing.id, {
                      ui: { ...editing.ui, [key]: e.target.value },
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>

          <div className="theme-group-title">Terminal colors</div>
          <div className="color-grid">
            {TERM_FIELDS.map(([key, label]) => (
              <label key={key} className="color-field">
                <input
                  type="color"
                  value={
                    (editing.terminal as Record<string, string>)[key] ||
                    "#000000"
                  }
                  onChange={(e) =>
                    updateTheme(editing.id, {
                      terminal: { ...editing.terminal, [key]: e.target.value },
                    })
                  }
                />
                <span>{label}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="theme-import">
        <div className="theme-group-title">Import theme</div>
        <div
          className={`theme-drop${dragOver ? " over" : ""}`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            void onPickFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
        >
          Drop a <code>.terminal</code> / <code>.itermcolors</code> / theme file
          here, or click to choose…
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".terminal,.itermcolors,.json,.xml,.plist"
          style={{ display: "none" }}
          onChange={(e) => {
            void onPickFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <textarea
          placeholder="…or paste theme contents (JSON / plist) — the format is auto-detected"
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          rows={4}
        />
        {importErr && <div className="ai-error">{importErr}</div>}
        <button
          onClick={() => importFrom(importText)}
          disabled={!importText.trim()}
        >
          Import pasted text
        </button>
      </div>
    </div>
  );
}

// ────────────────────────── Profiles ───────────────────────────

function ProfilesSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const profiles = settings.profiles ?? [];
  const editing = profiles.find((p) => p.id === editingId) ?? null;

  const addProfile = () => {
    const p: Profile = { id: uid(), name: "New profile" };
    onChange({ ...settings, profiles: [...profiles, p] });
    setEditingId(p.id);
  };

  const updateProfile = (id: string, patch: Partial<Profile>) =>
    onChange({
      ...settings,
      profiles: profiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    });

  const removeProfile = (id: string) =>
    onChange({
      ...settings,
      profiles: profiles.filter((p) => p.id !== id),
      defaultProfileId:
        settings.defaultProfileId === id ? null : settings.defaultProfileId,
    });

  return (
    <div className="theme-editor">
      <div className="theme-list">
        {profiles.length === 0 && (
          <p className="ai-hint">
            Profiles let a tab launch a specific shell with its own arguments,
            environment, and starting directory (e.g. a login zsh, PowerShell, or
            a project shell with custom env).
          </p>
        )}
        {profiles.map((p) => (
          <div key={p.id} className="theme-list-row">
            <button
              className={`theme-chip${editingId === p.id ? " active" : ""}`}
              onClick={() => setEditingId(p.id === editingId ? null : p.id)}
            >
              {p.name}
              {settings.defaultProfileId === p.id && (
                <span className="badge">default</span>
              )}
            </button>
            <button
              className="icon-btn"
              title="Set as default for new tabs"
              onClick={() => onChange({ ...settings, defaultProfileId: p.id })}
            >
              Default
            </button>
            <button
              className="icon-btn"
              title="Delete profile"
              onClick={() => removeProfile(p.id)}
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
        <div className="theme-actions">
          <button onClick={addProfile}>+ New profile</button>
          {settings.defaultProfileId && (
            <button
              onClick={() => onChange({ ...settings, defaultProfileId: null })}
            >
              Use default shell
            </button>
          )}
        </div>
      </div>

      {editing && (
        <ProfileEditor
          profile={editing}
          update={(patch) => updateProfile(editing.id, patch)}
        />
      )}
    </div>
  );
}

/** Per-profile editor. `args` and `env` are kept as raw local text so that
 *  in-progress typing (a key with no `=` yet, a trailing space) isn't parsed
 *  away and reformatted mid-keystroke — the parsed values are pushed to the
 *  stored profile on every change. Local text re-seeds when the profile id
 *  changes (i.e. a different profile is selected). */
function ProfileEditor({
  profile,
  update,
}: {
  profile: Profile;
  update: (patch: Partial<Profile>) => void;
}) {
  const [argsText, setArgsText] = useState((profile.args ?? []).join(" "));
  const [envText, setEnvText] = useState(serializeEnv(profile.env));

  useEffect(() => {
    setArgsText((profile.args ?? []).join(" "));
    setEnvText(serializeEnv(profile.env));
    // Re-seed only when switching to a different profile, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile.id]);

  return (
    <div className="theme-fields">
      <label className="setting-row">
        <span>Name</span>
        <input
          type="text"
          value={profile.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Shell</span>
        <input
          type="text"
          placeholder="default login shell (e.g. /bin/zsh, powershell.exe)"
          value={profile.shell ?? ""}
          onChange={(e) => update({ shell: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Arguments</span>
        <input
          type="text"
          placeholder="-l   (space-separated)"
          value={argsText}
          onChange={(e) => {
            setArgsText(e.target.value);
            update({ args: parseArgs(e.target.value) });
          }}
        />
      </label>
      <label className="setting-row">
        <span>Start directory</span>
        <input
          type="text"
          placeholder="inherit (last cwd / home)"
          value={profile.cwd ?? ""}
          onChange={(e) => update({ cwd: e.target.value })}
        />
      </label>
      <div className="theme-group-title">Environment (KEY=value per line)</div>
      <textarea
        rows={4}
        placeholder={"NODE_ENV=development\nFOO=bar"}
        value={envText}
        onChange={(e) => {
          setEnvText(e.target.value);
          update({ env: parseEnv(e.target.value) });
        }}
      />
      <p className="ai-hint">
        Changes apply to newly opened tabs that use this profile.
      </p>
    </div>
  );
}

// ────────────────────────── Snippets ───────────────────────────

function SnippetsSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const snippets = settings.snippets ?? [];

  const addSnippet = () => {
    const sn: Snippet = { id: uid(), name: "New snippet", command: "" };
    onChange({ ...settings, snippets: [...snippets, sn] });
  };

  const updateSnippet = (id: string, patch: Partial<Snippet>) =>
    onChange({
      ...settings,
      snippets: snippets.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });

  const removeSnippet = (id: string) =>
    onChange({
      ...settings,
      snippets: snippets.filter((s) => s.id !== id),
    });

  return (
    <div className="theme-editor">
      {snippets.length === 0 && (
        <p className="ai-hint">
          Snippets are saved commands you can run from the command palette
          (⌘⇧P) — they're listed as <code>Run: name</code> and sent to the
          focused terminal.
        </p>
      )}
      {snippets.map((sn) => (
        <div key={sn.id} className="snippet-row">
          <input
            type="text"
            className="snippet-name"
            placeholder="Name"
            value={sn.name}
            onChange={(e) => updateSnippet(sn.id, { name: e.target.value })}
          />
          <input
            type="text"
            className="snippet-cmd"
            placeholder="command to run"
            value={sn.command}
            onChange={(e) => updateSnippet(sn.id, { command: e.target.value })}
          />
          <button
            className="icon-btn"
            title="Delete snippet"
            onClick={() => removeSnippet(sn.id)}
          >
            <IconClose size={14} />
          </button>
        </div>
      ))}
      <div className="theme-actions">
        <button onClick={addSnippet}>+ New snippet</button>
      </div>
    </div>
  );
}

// ────────────────────────── SSH hosts ──────────────────────────

function SshSection({
  settings,
  onChange,
}: {
  settings: Settings;
  onChange: (s: Settings) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const hosts = settings.sshHosts ?? [];
  const editing = hosts.find((h) => h.id === editingId) ?? null;

  const addHost = () => {
    const h: SshHost = { id: uid(), name: "New host", host: "" };
    onChange({ ...settings, sshHosts: [...hosts, h] });
    setEditingId(h.id);
  };

  const updateHost = (id: string, patch: Partial<SshHost>) =>
    onChange({
      ...settings,
      sshHosts: hosts.map((h) => (h.id === id ? { ...h, ...patch } : h)),
    });

  const removeHost = (id: string) =>
    onChange({
      ...settings,
      sshHosts: hosts.filter((h) => h.id !== id),
    });

  return (
    <div className="theme-editor">
      <div className="theme-list">
        {hosts.length === 0 && (
          <p className="ai-hint">
            Saved SSH hosts open in a new tab running your system{" "}
            <code>ssh</code> client. Connect them from the command palette
            (⌘⇧P) as <code>SSH: name</code>, or with <code>rt ssh name</code>{" "}
            in any terminal.
          </p>
        )}
        {hosts.map((h) => (
          <div key={h.id} className="theme-list-row">
            <button
              className={`theme-chip${editingId === h.id ? " active" : ""}`}
              onClick={() => setEditingId(h.id === editingId ? null : h.id)}
            >
              {h.name}
              {h.host && (
                <span className="badge">
                  {h.user ? `${h.user}@${h.host}` : h.host}
                </span>
              )}
            </button>
            <button
              className="icon-btn"
              title="Delete host"
              onClick={() => removeHost(h.id)}
            >
              <IconClose size={14} />
            </button>
          </div>
        ))}
        <div className="theme-actions">
          <button onClick={addHost}>+ New host</button>
        </div>
      </div>

      {editing && (
        <SshEditor
          host={editing}
          settings={settings}
          update={(patch) => updateHost(editing.id, patch)}
        />
      )}
    </div>
  );
}

function SshEditor({
  host,
  settings,
  update,
}: {
  host: SshHost;
  settings: Settings;
  update: (patch: Partial<SshHost>) => void;
}) {
  return (
    <div className="theme-fields">
      <label className="setting-row">
        <span>Name</span>
        <input
          type="text"
          value={host.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Host</span>
        <input
          type="text"
          placeholder="example.com or 10.0.0.5"
          value={host.host}
          onChange={(e) => update({ host: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>User</span>
        <input
          type="text"
          placeholder="optional (e.g. root)"
          value={host.user ?? ""}
          onChange={(e) => update({ user: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Port</span>
        <input
          type="number"
          placeholder="22"
          value={host.port ?? ""}
          onChange={(e) =>
            update({
              port: e.target.value ? Number(e.target.value) : undefined,
            })
          }
        />
      </label>
      <label className="setting-row">
        <span>Identity file</span>
        <input
          type="text"
          placeholder="optional (e.g. ~/.ssh/id_ed25519)"
          value={host.identityFile ?? ""}
          onChange={(e) => update({ identityFile: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Extra args</span>
        <input
          type="text"
          placeholder="optional (e.g. -A -J jumphost)"
          value={host.extraArgs ?? ""}
          onChange={(e) => update({ extraArgs: e.target.value })}
        />
      </label>
      <label className="setting-row">
        <span>Theme on connect</span>
        <select
          value={host.themeId ?? ""}
          onChange={(e) => update({ themeId: e.target.value || undefined })}
        >
          <option value="">Don't change</option>
          {themeOptions(settings).map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <p className="ai-hint">
        Runs <code>ssh {host.user ? `${host.user}@` : ""}
        {host.host || "host"}</code>
        {host.port ? ` -p ${host.port}` : ""} in a new tab. Authentication
        (keys, known_hosts, prompts) uses your normal SSH setup.
      </p>
    </div>
  );
}
