import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyScore } from "../lib/fuzzy";

export interface Command {
  id: string;
  label: string;
  /** Optional shortcut hint shown on the right (e.g. "⌘D"). */
  hint?: string;
  run: () => void;
}

interface Props {
  commands: Command[];
  onClose: () => void;
}

const MAX_RESULTS = 50;

export function CommandPalette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    if (!query.trim()) return commands.slice(0, MAX_RESULTS);
    const scored: { cmd: Command; score: number }[] = [];
    for (const cmd of commands) {
      const s = fuzzyScore(query, cmd.label);
      if (s !== null) scored.push({ cmd, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, MAX_RESULTS).map((r) => r.cmd);
  }, [commands, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    const el = listRef.current?.children[sel] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (cmd: Command | undefined) => {
    if (!cmd) return;
    onClose();
    cmd.run();
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="quickopen" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="modal-input"
          placeholder="Run a command…"
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
          {results.map((cmd, i) => (
            <div
              key={cmd.id}
              className={`qo-row${i === sel ? " active" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(cmd)}
            >
              <span className="qo-base">{cmd.label}</span>
              {cmd.hint && <span className="qo-hint">{cmd.hint}</span>}
            </div>
          ))}
          {results.length === 0 && (
            <div className="qo-empty">No matching commands</div>
          )}
        </div>
      </div>
    </div>
  );
}
