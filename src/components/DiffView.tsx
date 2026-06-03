import { useEffect, useMemo, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { MergeView, unifiedMergeView } from "@codemirror/merge";
import { readFile, gitFileHead } from "../lib/fs";
import { langForFile } from "../lib/cmLang";
import { cmThemeFromDef } from "../lib/cmTheme";
import { resolveTheme, type Settings } from "../lib/settings";

interface Props {
  path: string;
  settings: Settings;
  visible: boolean;
  onClose?: () => void;
}

/** Read-only diff of a file's working-tree contents against its HEAD version.
 *  Side-by-side (old | new) or inline. */
export function DiffView({ path, settings, visible, onClose }: Props) {
  const [mode, setMode] = useState<"split" | "inline">("split");
  const [original, setOriginal] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MergeView | EditorView | null>(null);

  const name = path.split("/").pop() ?? path;
  const def = useMemo(
    () => resolveTheme(settings),
    [settings.theme, settings.customThemes],
  );
  const baseExt = useMemo(
    () => [
      lineNumbers(),
      EditorView.lineWrapping,
      EditorView.editable.of(false),
      EditorState.readOnly.of(true),
      ...cmThemeFromDef(def, {
        size: settings.fontSize,
        family: settings.fontFamily,
      }),
      ...langForFile(name),
    ],
    [def, settings.fontSize, settings.fontFamily, name],
  );

  // Load both sides when the file changes or this tab (re)gains visibility, so
  // the diff reflects the latest working tree after edits elsewhere.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setError(null);
    Promise.all([
      gitFileHead(path).catch(() => ""),
      readFile(path).catch(() => null),
    ]).then(([head, cur]) => {
      if (cancelled) return;
      if (cur === null) {
        setError("Cannot read this file.");
        return;
      }
      setOriginal(head ?? "");
      setCurrent(cur);
    });
    return () => {
      cancelled = true;
    };
  }, [path, visible]);

  // (Re)build the merge/unified view when docs, mode, or theme change.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || original === null || current === null) return;
    let view: MergeView | EditorView;
    if (mode === "split") {
      view = new MergeView({
        parent: host,
        a: { doc: original, extensions: baseExt },
        b: { doc: current, extensions: baseExt },
        collapseUnchanged: { margin: 3, minSize: 4 },
      });
    } else {
      view = new EditorView({
        parent: host,
        doc: current,
        extensions: [
          unifiedMergeView({ original, mergeControls: false }),
          ...baseExt,
        ],
      });
    }
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [mode, original, current, baseExt]);

  // Re-measure when this tab becomes visible (it may have been built hidden).
  useEffect(() => {
    if (!visible) return;
    const v = viewRef.current;
    if (!v) return;
    requestAnimationFrame(() => {
      if (v instanceof MergeView) {
        v.a.requestMeasure();
        v.b.requestMeasure();
      } else {
        v.requestMeasure();
      }
    });
  }, [visible, mode, current]);

  return (
    <div className="file-preview diff-view">
      <div className="fp-header">
        <span className="fp-name" title={path}>
          {name} <span className="fp-ro">— diff vs HEAD</span>
        </span>
        <div className="seg">
          <button
            className={mode === "split" ? "active" : ""}
            onClick={() => setMode("split")}
          >
            Split
          </button>
          <button
            className={mode === "inline" ? "active" : ""}
            onClick={() => setMode("inline")}
          >
            Inline
          </button>
        </div>
        {onClose && (
          <button className="fp-close" title="Close" onClick={onClose}>
            ×
          </button>
        )}
      </div>
      <div className="fp-body">
        {error ? (
          <div className="fp-error">{error}</div>
        ) : (
          <div className="diff-host" ref={hostRef} style={{ height: "100%" }} />
        )}
      </div>
    </div>
  );
}
