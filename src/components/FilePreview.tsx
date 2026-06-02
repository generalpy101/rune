import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { readFile, writeFile } from "../lib/fs";
import { langForFile } from "../lib/cmLang";

interface Props {
  path: string;
  onClose: () => void;
}

const MAX_BYTES = 2 * 1024 * 1024;

export function FilePreview({ path, onClose }: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [readonly, setReadonly] = useState(false);
  const [saving, setSaving] = useState(false);
  const contentRef = useRef(content);
  contentRef.current = content;

  const dirty = content !== original;
  const name = path.split("/").pop() ?? path;

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
      .catch(() =>
        setError("Cannot open this file (binary or unreadable)."),
      );
    return () => {
      cancelled = true;
    };
  }, [path]);

  const save = useMemo(
    () => async () => {
      if (readonly) return;
      setSaving(true);
      try {
        await writeFile(path, contentRef.current);
        setOriginal(contentRef.current);
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    },
    [path, readonly],
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

  const extensions = useMemo(
    () => [saveKeymap, EditorView.lineWrapping, ...langForFile(name)],
    [saveKeymap, name],
  );

  return (
    <div className="file-preview">
      <div className="fp-header">
        <span className="fp-name" title={path}>
          {name}
          {dirty && <span className="fp-dirty"> ●</span>}
          {readonly && <span className="fp-ro"> (read-only)</span>}
        </span>
        {!readonly && (
          <button
            title="Save (⌘S)"
            onClick={() => save()}
            disabled={!dirty || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        )}
        <button title="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="fp-body">
        {error ? (
          <div className="fp-error">{error}</div>
        ) : (
          <CodeMirror
            value={content}
            theme={oneDark}
            extensions={extensions}
            editable={!readonly}
            onChange={setContent}
            height="100%"
            style={{ height: "100%" }}
          />
        )}
      </div>
    </div>
  );
}
