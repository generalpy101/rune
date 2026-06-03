import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorView, keymap } from "@codemirror/view";
import { Prec, type EditorState } from "@codemirror/state";
import { openSearchPanel, gotoLine } from "@codemirror/search";
import { readFile, writeFile } from "../lib/fs";
import { langForFile, langKeyForFile, langLabel } from "../lib/cmLang";
import { cmThemeFromDef } from "../lib/cmTheme";
import { completionFor } from "../lib/cmComplete";
import { statusListener } from "../lib/cmStatus";
import { resolveTheme, type Settings } from "../lib/settings";

interface Props {
  path: string;
  settings: Settings;
  /** Whether this editor's tab is the active one. */
  visible: boolean;
  /** Reports unsaved-changes state up so the tab can show a dirty dot. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Reveal this file in the sidebar file browser. */
  onReveal?: (path: string) => void;
  /** Open a diff (working tree vs HEAD) for this file in a new tab. */
  onDiff?: (path: string) => void;
  /** Close this editor tab (prompts if there are unsaved changes). */
  onClose?: () => void;
  /** Fires after a successful write (manual, autosave, or flush). */
  onSaved?: () => void;
}

const MAX_BYTES = 2 * 1024 * 1024;

/** Trim trailing whitespace per line and ensure a single final newline. */
function tidyText(text: string): string {
  let out = text.replace(/[ \t]+$/gm, "");
  if (out.length > 0) out = out.replace(/\n*$/, "\n");
  return out;
}

/** Rough indent style of a file (for the status bar) from its first lines. */
function detectIndent(text: string): string {
  const lines = text.split("\n").slice(0, 200);
  let tabbed = 0;
  let minSpace = 0;
  for (const ln of lines) {
    if (ln.startsWith("\t")) {
      tabbed++;
      continue;
    }
    const m = /^( +)\S/.exec(ln);
    if (m && (minSpace === 0 || m[1].length < minSpace)) minSpace = m[1].length;
  }
  if (tabbed > 0 && minSpace === 0) return "Tabs";
  return `Spaces: ${minSpace || 2}`;
}

export function FilePreview({
  path,
  settings,
  visible,
  onDirtyChange,
  onReveal,
  onDiff,
  onClose,
  onSaved,
}: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [readonly, setReadonly] = useState(false);
  const [saving, setSaving] = useState(false);

  // Mirrors of state for async callbacks / listeners that capture stale values.
  const contentRef = useRef(content);
  contentRef.current = content;
  const savingRef = useRef(saving);
  savingRef.current = saving;
  const originalRef = useRef(original);
  originalRef.current = original;

  const autosave = settings.autosave;
  const autosaveDelay = settings.autosaveDelayMs;
  const autosaveRef = useRef(autosave);
  autosaveRef.current = autosave;
  const readonlyRef = useRef(readonly);
  readonlyRef.current = readonly;
  const tidyOnSaveRef = useRef(settings.tidyOnSave);
  tidyOnSaveRef.current = settings.tidyOnSave;

  const dirty = content !== original;
  const name = path.split("/").pop() ?? path;
  const langKey = useMemo(() => langKeyForFile(name), [name]);
  const indent = useMemo(() => detectIndent(original), [original]);
  const words = useMemo(() => {
    const t = content.trim();
    return t ? t.split(/\s+/).length : 0;
  }, [content]);
  const statusElRef = useRef<HTMLSpanElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Report dirty state up for the tab dot.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  // Load the file when the path changes.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    setContent("");
    setOriginal("");
    setReadonly(false);
    readFile(path)
      .then((text) => {
        if (cancelled) return;
        if (text.length > MAX_BYTES) {
          setContent(text.slice(0, MAX_BYTES));
          setOriginal(text.slice(0, MAX_BYTES));
          setReadonly(true); // too large to safely edit/save
        } else {
          setContent(text);
          setOriginal(text);
        }
      })
      .catch(() => setError("Cannot open this file (binary or unreadable)."));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useMemo(
    () => async () => {
      if (readonly) return;
      setSaving(true);
      try {
        let text = contentRef.current;
        if (tidyOnSaveRef.current) {
          const tidied = tidyText(text);
          if (tidied !== text) {
            text = tidied;
            setContent(tidied); // reflect the tidy in the editor
          }
        }
        await writeFile(path, text);
        setOriginal(text);
        onSaved?.();
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [path, readonly, onSaved],
  );

  // Flush a pending autosave for the CURRENT file (used by blur + debounce).
  const flushSave = useRef<() => void>(() => {});
  flushSave.current = () => {
    if (readonly || !autosave) return;
    if (savingRef.current) return;
    if (contentRef.current === original) return;
    void save();
  };

  // Debounced autosave: fire `autosaveDelay` ms after edits stop.
  useEffect(() => {
    if (!autosave || readonly) return;
    if (content === original) return;
    const id = window.setTimeout(() => flushSave.current(), autosaveDelay);
    return () => clearTimeout(id);
  }, [content, original, autosave, autosaveDelay, readonly]);

  // Flush when the window loses focus (e.g. switching apps).
  useEffect(() => {
    const onWinBlur = () => flushSave.current();
    window.addEventListener("blur", onWinBlur);
    return () => window.removeEventListener("blur", onWinBlur);
  }, []);

  // Flush this file's edits when the tab is closed (component unmounts), while
  // refs still hold its content.
  useEffect(() => {
    const p = path;
    return () => {
      if (readonlyRef.current || !autosaveRef.current) return;
      if (contentRef.current === originalRef.current) return;
      const text = tidyOnSaveRef.current
        ? tidyText(contentRef.current)
        : contentRef.current;
      void writeFile(p, text)
        .then(() => onSaved?.())
        .catch(() => {});
    };
  }, [path]);

  const def = useMemo(
    () => resolveTheme(settings),
    [settings.theme, settings.customThemes],
  );
  const cmTheme = useMemo(
    () =>
      cmThemeFromDef(def, {
        size: settings.fontSize,
        family: settings.fontFamily,
      }),
    [def, settings.fontSize, settings.fontFamily],
  );

  // ⌘S / Ctrl+S to save, captured at high precedence inside the editor.
  const saveKeymap = useMemo(
    () =>
      Prec.highest(
        keymap.of([
          {
            key: "Mod-s",
            run: () => {
              void save();
              return true;
            },
          },
        ]),
      ),
    [save],
  );

  // Cursor position → status bar, written imperatively (no re-render per move).
  const statusExt = useMemo(
    () =>
      statusListener((s) => {
        const el = statusElRef.current;
        if (!el) return;
        el.textContent =
          `Ln ${s.line}, Col ${s.col}` +
          (s.selLen ? ` (${s.selLen} selected)` : "");
      }),
    [],
  );

  const completion = useMemo(() => completionFor(langKey), [langKey]);

  const extensions = useMemo(
    () => [
      saveKeymap,
      statusExt,
      cmTheme,
      completion,
      EditorView.lineWrapping,
      ...langForFile(name),
    ],
    [saveKeymap, statusExt, cmTheme, completion, name],
  );

  // Re-measure / refocus when this tab becomes visible.
  useEffect(() => {
    if (!visible) return;
    const v = viewRef.current;
    if (!v) return;
    requestAnimationFrame(() => v.requestMeasure());
  }, [visible, content]);

  const withView = (fn: (v: EditorView) => void) => {
    const v = viewRef.current;
    if (!v) return;
    v.focus();
    fn(v);
  };

  return (
    <div className="file-preview">
      <div className="fp-header">
        {readonly && <span className="fp-ro">read-only</span>}
        <span className="fp-spacer" />
        <button
          className="fp-tool"
          title="Find / Replace (⌘F)"
          disabled={!!error}
          onClick={() => withView(openSearchPanel)}
        >
          Find
        </button>
        <button
          className="fp-tool"
          title="Go to line"
          disabled={!!error}
          onClick={() => withView(gotoLine)}
        >
          Go to line
        </button>
        <button
          className="fp-tool"
          title="Copy absolute path"
          onClick={() => navigator.clipboard?.writeText(path).catch(() => {})}
        >
          Copy path
        </button>
        {onReveal && (
          <button
            className="fp-tool"
            title="Reveal in file browser"
            onClick={() => onReveal(path)}
          >
            Reveal
          </button>
        )}
        {onDiff && (
          <button
            className="fp-tool"
            title="Diff against HEAD (git)"
            onClick={() => onDiff(path)}
          >
            Diff
          </button>
        )}
        {!readonly && (
          <button
            className="fp-save"
            title="Save (⌘S)"
            onClick={() => save()}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        {onClose && (
          <button className="fp-close" title="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div className="fp-body" onBlur={() => flushSave.current()}>
        {error ? (
          <div className="fp-error">{error}</div>
        ) : (
          <CodeMirror
            value={content}
            theme="none"
            extensions={extensions}
            editable={!readonly}
            onChange={setContent}
            onCreateEditor={(view: EditorView, _state: EditorState) => {
              viewRef.current = view;
            }}
            height="100%"
            style={{ height: "100%" }}
          />
        )}
      </div>
      <div className="fp-status">
        <span ref={statusElRef}>Ln 1, Col 1</span>
        <span>{langLabel(langKey)}</span>
        <span>{indent}</span>
        <span>{words} words</span>
        {autosave && !readonly && <span className="fp-auto">Autosave</span>}
      </div>
    </div>
  );
}
