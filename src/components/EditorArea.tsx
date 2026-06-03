import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { FilePreview } from "./FilePreview";
import { DiffView } from "./DiffView";
import { IconClose } from "../lib/icons";
import { confirmDialog } from "../lib/dialogs";
import type { Settings } from "../lib/settings";

export type EditorItem = { kind: "file" | "diff"; path: string };

export const itemKey = (it: EditorItem): string => `${it.kind}:${it.path}`;

/** Imperative API so global keyboard shortcuts can drive the editor tabs. */
export interface EditorAreaHandle {
  closeActive: () => void;
  nextTab: () => void;
  prevTab: () => void;
}

interface Props {
  items: EditorItem[];
  activeKey: string | null;
  settings: Settings;
  onActivate: (key: string) => void;
  onClose: (key: string) => void;
  onReveal: (path: string) => void;
  onDiff: (path: string) => void;
  onSaved: () => void;
}

/** The editor pane: a tab strip over a stack of open files / diffs. All open
 *  editors stay mounted (hidden when inactive) so switching tabs preserves
 *  unsaved edits, cursor, and scroll position. */
export const EditorArea = forwardRef<EditorAreaHandle, Props>(function EditorArea(
  { items, activeKey, settings, onActivate, onClose, onReveal, onDiff, onSaved },
  ref,
) {
  const [dirtyMap, setDirtyMap] = useState<Record<string, boolean>>({});

  const setDirtyFor = useCallback((key: string, d: boolean) => {
    setDirtyMap((m) => (m[key] === d ? m : { ...m, [key]: d }));
  }, []);

  // Stable per-key dirty reporter so FilePreview's effect identity is steady.
  const dirtyCbs = useRef<Map<string, (d: boolean) => void>>(new Map());
  const dirtyCb = (key: string) => {
    let cb = dirtyCbs.current.get(key);
    if (!cb) {
      cb = (d: boolean) => setDirtyFor(key, d);
      dirtyCbs.current.set(key, cb);
    }
    return cb;
  };

  const handleClose = async (it: EditorItem) => {
    const key = itemKey(it);
    if (it.kind === "file" && dirtyMap[key] && !settings.autosave) {
      const ok = await confirmDialog(
        `${it.path.split("/").pop()} has unsaved changes. Close without saving?`,
      );
      if (!ok) return;
    }
    dirtyCbs.current.delete(key);
    onClose(key);
  };

  const cycle = (dir: 1 | -1) => {
    if (items.length < 2) return;
    const idx = items.findIndex((i) => itemKey(i) === activeKey);
    const ni = ((idx < 0 ? 0 : idx) + dir + items.length) % items.length;
    onActivate(itemKey(items[ni]));
  };

  useImperativeHandle(ref, () => ({
    closeActive: () => {
      const it = items.find((i) => itemKey(i) === activeKey);
      if (it) void handleClose(it);
    },
    nextTab: () => cycle(1),
    prevTab: () => cycle(-1),
  }));

  return (
    <div className="editor-area">
      <div className="editor-tabs" role="tablist">
        {items.map((it) => {
          const key = itemKey(it);
          const name = it.path.split("/").pop() ?? it.path;
          const active = key === activeKey;
          return (
            <div
              key={key}
              className={`editor-tab${active ? " active" : ""}`}
              role="tab"
              aria-selected={active}
              title={it.path}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void handleClose(it);
                } else {
                  onActivate(key);
                }
              }}
            >
              <span className="et-name">
                {it.kind === "diff" ? "⇄ " : ""}
                {name}
                {it.kind === "file" && dirtyMap[key] && (
                  <span className="et-dirty"> ●</span>
                )}
              </span>
              <button
                className="et-close"
                title="Close tab"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleClose(it);
                }}
              >
                <IconClose size={11} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="editor-stack">
        {items.map((it) => {
          const key = itemKey(it);
          const active = key === activeKey;
          return (
            <div
              key={key}
              className="editor-slot"
              style={{ display: active ? "flex" : "none" }}
            >
              {it.kind === "file" ? (
                <FilePreview
                  path={it.path}
                  settings={settings}
                  visible={active}
                  onDirtyChange={dirtyCb(key)}
                  onReveal={onReveal}
                  onDiff={onDiff}
                  onClose={() => void handleClose(it)}
                  onSaved={onSaved}
                />
              ) : (
                <DiffView
                  path={it.path}
                  settings={settings}
                  visible={active}
                  onClose={() => void handleClose(it)}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});
