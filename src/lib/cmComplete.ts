import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";

/**
 * Per-language keyword lists. To teach the editor a new language's keywords,
 * add ONE line here keyed by the `langKey` from `langKeyForFile` (see cmLang.ts).
 * That's the whole job — no other file needs to change.
 *
 * This is deliberately lightweight: keyword + identifier completion is local,
 * instant, and zero-RAM. For real type-aware IntelliSense, see the LSP note at
 * the bottom of this file — `completionFor` is the seam to swap a richer source
 * in per language without touching FilePreview.
 */
const KEYWORDS: Record<string, string[]> = {
  rust: ["fn","let","mut","pub","struct","enum","impl","trait","use","mod","match","if","else","for","while","loop","return","async","await","move","ref","const","static","unsafe","where","dyn","crate","self","Self","Some","None","Ok","Err","Vec","String","Option","Result","Box","derive"],
  ts: ["const","let","var","function","return","if","else","for","while","switch","case","break","continue","interface","type","class","extends","implements","import","export","from","default","async","await","public","private","protected","readonly","static","new","this","typeof","keyof","as","satisfies","never","unknown","void","null","undefined"],
  js: ["const","let","var","function","return","if","else","for","while","switch","case","break","continue","class","extends","import","export","from","default","async","await","new","this","typeof","null","undefined","true","false"],
  py: ["def","class","return","if","elif","else","for","while","import","from","as","with","try","except","finally","raise","lambda","yield","async","await","pass","break","continue","global","nonlocal","self","None","True","False","and","or","not","in","is"],
  go: ["func","package","import","var","const","type","struct","interface","map","chan","go","defer","return","if","else","for","range","switch","case","select","break","continue","nil","make","new"],
  shell: ["if","then","elif","else","fi","for","in","do","done","while","until","case","esac","function","echo","export","local","return","read","source","alias","unset"],
};

/** Local completion: the language's keywords, offered while typing a word. */
function keywordSource(words: string[]): CompletionSource {
  const options: Completion[] = words.map((w) => ({ label: w, type: "keyword" }));
  return (ctx: CompletionContext): CompletionResult | null => {
    if (!options.length) return null;
    const word = ctx.matchBefore(/\w+/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    return { from: word.from, options, validFor: /^\w*$/ };
  };
}

/**
 * Generic "complete from this document": harvests identifiers already present
 * in the file. A single regex pass over the (≤2 MB) doc, capped, no network —
 * works in every language and keeps the editor snappy.
 */
function documentWordSource(ctx: CompletionContext): CompletionResult | null {
  const word = ctx.matchBefore(/\w+/);
  if (!word || (word.from === word.to && !ctx.explicit)) return null;
  const text = ctx.state.doc.toString();
  const seen = new Set<string>();
  for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
    seen.add(m[0]);
    if (seen.size > 1000) break;
  }
  seen.delete(word.text);
  const options: Completion[] = [...seen]
    .slice(0, 500)
    .map((label) => ({ label, type: "variable" }));
  if (!options.length) return null;
  return { from: word.from, options, validFor: /^\w*$/ };
}

/**
 * Autocomplete extension for a language. Combines that language's keywords with
 * document-word completion. NOTE: `override` replaces a `lang-*` package's own
 * completion source (e.g. CSS property completion) in this v1 — acceptable for a
 * uniform, fast baseline.
 *
 * FUTURE (LSP): for languages with a server, replace/augment the sources here
 * with `codemirror-languageserver` driven by a Tauri sidecar (rust-analyzer,
 * typescript-language-server, pyright), gated behind a settings flag. Callers
 * (FilePreview) don't change — this function stays the only seam.
 */
/** Languages that share another language's keyword set. */
const ALIAS: Record<string, string> = { tsx: "ts", jsx: "js" };

export function completionFor(langKey: string): Extension {
  const kw = KEYWORDS[ALIAS[langKey] ?? langKey] ?? [];
  return autocompletion({
    activateOnTyping: true,
    maxRenderedOptions: 50,
    override: [keywordSource(kw), documentWordSource],
  });
}
