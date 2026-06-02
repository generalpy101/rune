import { useEffect, useState } from "react";
import { gitBranch } from "../lib/fs";
import { IconGitBranch, IconFolder } from "../lib/icons";

interface Props {
  /** Current workspace directory (follows the focused terminal's cwd). */
  cwd: string | null;
  /** Active tab's shell profile name, or null for the default shell. */
  profileName: string | null;
  /** Focused terminal grid size. */
  rows: number | null;
  cols: number | null;
}

/** Compact bottom status bar: cwd, git branch, profile, and terminal size. */
export function StatusBar({ cwd, profileName, rows, cols }: Props) {
  const [branch, setBranch] = useState<string | null>(null);

  // Refresh the git branch when the directory changes.
  useEffect(() => {
    let cancelled = false;
    if (!cwd) {
      setBranch(null);
      return;
    }
    gitBranch(cwd)
      .then((b) => {
        if (!cancelled) setBranch(b);
      })
      .catch(() => {
        if (!cancelled) setBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cwd]);

  const shortCwd = cwd
    ? cwd.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~")
    : "";

  return (
    <div className="statusbar">
      <div className="statusbar-left">
        {cwd && (
          <span className="status-item" title={cwd}>
            <IconFolder size={12} />
            {shortCwd}
          </span>
        )}
        {branch && (
          <span className="status-item" title="Current git branch">
            <IconGitBranch size={12} />
            {branch}
          </span>
        )}
      </div>
      <div className="statusbar-right">
        {profileName && <span className="status-item">{profileName}</span>}
        {rows != null && cols != null && (
          <span className="status-item">
            {cols}×{rows}
          </span>
        )}
      </div>
    </div>
  );
}
