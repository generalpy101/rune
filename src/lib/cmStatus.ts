import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";

export interface StatusInfo {
  /** 1-based line number of the cursor head. */
  line: number;
  /** 1-based column of the cursor head. */
  col: number;
  /** Number of selected characters (0 when there's no selection). */
  selLen: number;
}

/**
 * Reports cursor line/column and selection length whenever the selection or doc
 * changes. The callback should write to the DOM imperatively (not React state)
 * so moving the cursor never re-renders the editor.
 */
export function statusListener(onChange: (s: StatusInfo) => void): Extension {
  return EditorView.updateListener.of((u) => {
    if (!u.selectionSet && !u.docChanged) return;
    const range = u.state.selection.main;
    const line = u.state.doc.lineAt(range.head);
    onChange({
      line: line.number,
      col: range.head - line.from + 1,
      selLen: range.to - range.from,
    });
  });
}
