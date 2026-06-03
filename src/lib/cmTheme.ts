import { EditorView } from "@codemirror/view";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import type { ThemeDef } from "./settings";

export interface EditorFont {
  size: number;
  family: string;
}

/** Build a CodeMirror 6 theme (chrome) + syntax highlight style from one of the
 *  app's `ThemeDef`s, so the editor always matches the rest of the UI — dark or
 *  light, built-in or custom. Chrome colours come from `def.ui`; syntax token
 *  colours reuse the terminal ANSI palette (`def.terminal`) for a consistent
 *  look with the embedded terminal. */
export function cmThemeFromDef(def: ThemeDef, font: EditorFont): Extension[] {
  const ui = def.ui;
  const term = def.terminal;
  const bg = term.background ?? ui.panel;
  const fg = term.foreground ?? ui.text;
  const selection = term.selectionBackground ?? ui.panel3;
  const cursor = term.cursor ?? ui.accent;

  const theme = EditorView.theme(
    {
      "&": {
        color: ui.text,
        backgroundColor: bg,
        fontSize: `${font.size}px`,
        height: "100%",
      },
      ".cm-content": {
        caretColor: cursor,
        fontFamily: font.family,
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: cursor },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
        { backgroundColor: selection },
      ".cm-activeLine": { backgroundColor: ui.panel3 },
      ".cm-gutters": {
        backgroundColor: bg,
        color: ui.muted,
        border: "none",
        fontFamily: font.family,
      },
      ".cm-activeLineGutter": { backgroundColor: ui.panel3, color: ui.text },
      ".cm-foldPlaceholder": {
        backgroundColor: ui.panel3,
        border: "none",
        color: ui.muted,
      },
      ".cm-scroller": { fontFamily: font.family },
      ".cm-panels": { backgroundColor: ui.panel2, color: ui.text },
      ".cm-panels.cm-panels-top": { borderBottom: `1px solid ${ui.border}` },
      ".cm-panels.cm-panels-bottom": { borderTop: `1px solid ${ui.border}` },
      ".cm-searchMatch": {
        backgroundColor: selection,
        outline: `1px solid ${ui.border}`,
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: ui.accent,
        color: ui.accentFg,
      },
      ".cm-selectionMatch": { backgroundColor: ui.panel3 },
      "&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket": {
        backgroundColor: ui.panel3,
        outline: `1px solid ${ui.muted}`,
      },
      ".cm-tooltip": {
        backgroundColor: ui.panel2,
        border: `1px solid ${ui.border}`,
        color: ui.text,
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: ui.border,
        borderBottomColor: ui.border,
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: ui.panel2,
        borderBottomColor: ui.panel2,
      },
      ".cm-tooltip-autocomplete": {
        "& > ul": { fontFamily: font.family },
        "& > ul > li[aria-selected]": {
          backgroundColor: ui.accent,
          color: ui.accentFg,
        },
      },
      ".cm-completionIcon": { color: ui.muted },
    },
    { dark: def.dark },
  );

  const highlight = HighlightStyle.define(
    [
      { tag: t.comment, color: ui.muted, fontStyle: "italic" },
      {
        tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword],
        color: term.magenta ?? ui.purple,
      },
      { tag: [t.string, t.special(t.string), t.regexp], color: term.green },
      { tag: t.escape, color: term.cyan },
      {
        tag: [
          t.number,
          t.bool,
          t.atom,
          t.constant(t.name),
          t.standard(t.name),
        ],
        color: term.yellow,
      },
      {
        tag: [t.function(t.variableName), t.function(t.propertyName)],
        color: term.blue,
      },
      { tag: [t.typeName, t.className, t.namespace], color: term.cyan },
      { tag: [t.propertyName, t.attributeName], color: term.cyan },
      { tag: [t.variableName, t.labelName], color: fg },
      { tag: t.tagName, color: term.red },
      {
        tag: [t.operator, t.punctuation, t.separator, t.bracket],
        color: ui.muted,
      },
      { tag: [t.meta, t.processingInstruction], color: term.cyan },
      { tag: t.heading, color: term.blue, fontWeight: "bold" },
      { tag: [t.link, t.url], color: term.blue, textDecoration: "underline" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strong, fontWeight: "bold" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: t.inserted, color: ui.success },
      { tag: [t.deleted, t.invalid], color: ui.danger },
    ],
    { themeType: def.dark ? "dark" : "light", all: { color: fg } },
  );

  return [theme, syntaxHighlighting(highlight)];
}
