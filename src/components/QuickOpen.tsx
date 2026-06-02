import { useEffect, useMemo, useRef, useState } from "react";
import { walkDir } from "../lib/fs";
import { fuzzyScore } from "../lib/fuzzy";

interface Props {
  root: string;
  onOpen: (path: string) => void;
  onClose: () => void;
}

const MAX_RESULTS = 60;

export function QuickOpen({ root, onOpen, onClose }: Props) {
  const [files, setFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const [loading, setLoading] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const prefix = root.endsWith("/") ? root : root + "/";

  useEffect(() => {
    let cancelled = false;
    walkDir(root)
      .then((f) => {
        if (!cancelled) {
          setFiles(f);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [root]);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const scored: { path: string; score: number }[] = [];
    for (const path of files) {
      const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
      const s = fuzzyScore(query, rel);
      if (s !== null) scored.push({ path, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.path);
  }, [files, query, prefix]);

  // Keep selection in range and scrolled into view.
  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (path: string | undefined) => {
    if (!path) return;
    onOpen(path);
    onClose();
  };

  const rel = (path: string) =>
    path.startsWith(prefix) ? path.slice(prefix.length) : path;
  const base = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const dir = (path: string) => {
    const r = rel(path);
    const i = r.lastIndexOf("/");
    return i < 0 ? "" : r.slice(0, i + 1);
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quickopen" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="modal-input"
          placeholder={loading ? "Indexing files…" : "Go to file…"}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              choose(results[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
        />
        <div className="quickopen-list" ref={listRef}>
          {results.map((path, i) => (
            <div
              key={path}
              className={`qo-row${i === sel ? " active" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(path)}
            >
              <span className="qo-base">{base(path)}</span>
              <span className="qo-dir">{dir(path)}</span>
            </div>
          ))}
          {!loading && results.length === 0 && (
            <div className="qo-empty">No matching files</div>
          )}
        </div>
      </div>
    </div>
  );
}
