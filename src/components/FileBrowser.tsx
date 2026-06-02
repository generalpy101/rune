import { useCallback, useEffect, useState } from "react";
import {
  listDir,
  createFile,
  createDir,
  renamePath,
  deletePath,
  copyPath,
  movePath,
  duplicatePath,
  gitStatus,
  type DirEntry,
  type GitStatus,
} from "../lib/fs";
import { promptDialog, confirmDialog, alertDialog } from "../lib/dialogs";
import { FileIcon } from "../lib/fileIcons";
import {
  IconArrowUp,
  IconNewFile,
  IconNewFolder,
  IconRefresh,
  IconFilter,
  IconBookmark,
  IconClose,
} from "../lib/icons";
import { ContextMenu, type MenuItem } from "./ContextMenu";

/** A file/folder cut or copied for a later paste. */
interface Clip {
  path: string;
  cut: boolean;
}

/** Shared file-operation handlers threaded through the recursive tree. */
interface FileOps {
  clip: Clip | null;
  onCopy: (path: string) => void;
  onCut: (path: string) => void;
  onPaste: (destDir: string, reload: () => void) => void;
  onDuplicate: (path: string, reload: () => void) => void;
  bookmarks: string[];
  onToggleBookmark: (path: string) => void;
  showHidden: boolean;
}

function basename(p: string): string {
  const t = p.replace(/\/+$/, "");
  const idx = t.lastIndexOf("/");
  return idx < 0 ? t : t.slice(idx + 1);
}

/** Single-letter badge + class for a git status category. */
function gitBadge(category: string): { mark: string; cls: string } {
  switch (category) {
    case "untracked":
      return { mark: "U", cls: "untracked" };
    case "added":
      return { mark: "A", cls: "added" };
    case "deleted":
      return { mark: "D", cls: "deleted" };
    case "modified":
      return { mark: "M", cls: "modified" };
    default:
      return { mark: "•", cls: "changed" };
  }
}

/** True when any tracked path under `dir` has changes. */
function dirDirty(dir: string, git: GitStatus): boolean {
  const prefix = dir.endsWith("/") ? dir : dir + "/";
  for (const p in git) {
    if (p.startsWith(prefix)) return true;
  }
  return false;
}

interface Props {
  rootPath: string;
  onNavigateRoot: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCdHere: (path: string) => void;
  onReveal: (path: string) => void;
  onNewTerminalHere: (path: string) => void;
  /** Show dotfiles / hidden entries. */
  showHidden: boolean;
  /** Bookmarked folders for quick navigation. */
  bookmarks: string[];
  /** Add or remove `path` from the bookmarks list. */
  onToggleBookmark: (path: string) => void;
}

function dirname(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

/** Break an absolute path into clickable breadcrumb segments (root first). */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split("/").filter(Boolean);
  const out = [{ name: "/", path: "/" }];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    out.push({ name: p, path: acc });
  }
  return out;
}

function join(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function FileBrowser({
  rootPath,
  onNavigateRoot,
  onOpenFile,
  onCdHere,
  onReveal,
  onNewTerminalHere,
  showHidden,
  bookmarks,
  onToggleBookmark,
}: Props) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [git, setGit] = useState<GitStatus>({});
  const [rootMenu, setRootMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [clip, setClip] = useState<Clip | null>(null);
  const [filter, setFilter] = useState("");
  const [showFilter, setShowFilter] = useState(false);

  // Paste the clipboard entry into `destDir` (copy, or move when it was cut).
  const pasteInto = useCallback(
    async (destDir: string, reload: () => void) => {
      if (!clip) return;
      const dest = join(destDir, basename(clip.path));
      try {
        if (clip.cut) {
          await movePath(clip.path, dest);
          setClip(null);
        } else {
          await copyPath(clip.path, dest);
        }
        reload();
      } catch (e) {
        await alertDialog(String(e));
      }
    },
    [clip],
  );

  const duplicate = useCallback(async (path: string, reload: () => void) => {
    try {
      await duplicatePath(path);
      reload();
    } catch (e) {
      await alertDialog(String(e));
    }
  }, []);

  const fileOps: FileOps = {
    clip,
    onCopy: (p) => setClip({ path: p, cut: false }),
    onCut: (p) => setClip({ path: p, cut: true }),
    onPaste: pasteInto,
    onDuplicate: duplicate,
    bookmarks,
    onToggleBookmark,
    showHidden,
  };

  const reload = useCallback(() => {
    listDir(rootPath)
      .then((e) => {
        setEntries(e);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    gitStatus(rootPath)
      .then(setGit)
      .catch(() => setGit({}));
  }, [rootPath]);

  // Reload on mount/root change, then keep the top level fresh: poll on an
  // interval and whenever the window regains focus, so changes made by agents,
  // the terminal, or other apps show up without a manual refresh.
  useEffect(() => {
    reload();
    const timer = setInterval(reload, 2500);
    const onFocus = () => reload();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [reload]);

  const newAtRoot = async (isDir: boolean) => {
    const name = await promptDialog(
      isDir ? "New folder name" : "New file name",
    );
    if (!name) return;
    const target = join(rootPath, name);
    try {
      await (isDir ? createDir(target) : createFile(target));
      reload();
    } catch (e) {
      await alertDialog(String(e));
    }
  };

  return (
    <div className="file-browser">
      <div className="fb-header">
        <button
          className="fb-tool icon-btn"
          title="Up one level"
          onClick={() => onNavigateRoot(dirname(rootPath))}
        >
          <IconArrowUp size={15} />
        </button>
        <div className="fb-crumbs">
          {crumbs(rootPath).map((c, i, arr) => (
            <span key={c.path} className="fb-crumb-wrap">
              <button
                className={`fb-crumb${i === arr.length - 1 ? " current" : ""}`}
                title={c.path}
                onClick={() => onNavigateRoot(c.path)}
              >
                {c.name}
              </button>
              {i < arr.length - 1 && <span className="fb-crumb-sep">›</span>}
            </span>
          ))}
        </div>
        <button
          className="fb-tool icon-btn"
          title="New file"
          onClick={() => newAtRoot(false)}
        >
          <IconNewFile size={15} />
        </button>
        <button
          className="fb-tool icon-btn"
          title="New folder"
          onClick={() => newAtRoot(true)}
        >
          <IconNewFolder size={15} />
        </button>
        <button
          className={`fb-tool icon-btn${showFilter ? " active" : ""}`}
          title="Filter"
          onClick={() => {
            setShowFilter((v) => !v);
            if (showFilter) setFilter("");
          }}
        >
          <IconFilter size={15} />
        </button>
        <button className="fb-tool icon-btn" title="Refresh" onClick={reload}>
          <IconRefresh size={15} />
        </button>
      </div>
      {bookmarks.length > 0 && (
        <div className="fb-bookmarks">
          {bookmarks.map((b) => (
            <button
              key={b}
              className="fb-bookmark"
              title={b}
              onClick={() => onNavigateRoot(b)}
            >
              <IconBookmark size={12} />
              <span>{basename(b) || b}</span>
              <span
                className="fb-bookmark-x"
                title="Remove bookmark"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleBookmark(b);
                }}
              >
                <IconClose size={11} />
              </span>
            </button>
          ))}
        </div>
      )}
      {showFilter && (
        <div className="fb-filter">
          <input
            autoFocus
            placeholder="Filter…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setFilter("");
                setShowFilter(false);
              }
            }}
          />
        </div>
      )}
      <div
        className="fb-tree"
        onContextMenu={(e) => {
          e.preventDefault();
          setRootMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {error && <div className="fb-error">{error}</div>}
        {rootMenu && (
          <ContextMenu
            x={rootMenu.x}
            y={rootMenu.y}
            items={[
              { label: "New File…", onClick: () => newAtRoot(false) },
              { label: "New Folder…", onClick: () => newAtRoot(true) },
              ...(clip
                ? [
                    {
                      label: clip.cut ? "Paste (move) Here" : "Paste Here",
                      onClick: () => pasteInto(rootPath, reload),
                    },
                  ]
                : []),
              {
                label: bookmarks.includes(rootPath)
                  ? "Remove Bookmark"
                  : "Bookmark This Folder",
                onClick: () => onToggleBookmark(rootPath),
              },
              {
                label: "New Terminal Here",
                separator: true,
                onClick: () => onNewTerminalHere(rootPath),
              },
              { label: "Reveal in Finder", onClick: () => onReveal(rootPath) },
              { label: "Refresh", separator: true, onClick: reload },
            ]}
            onClose={() => setRootMenu(null)}
          />
        )}
        {entries
          .filter(
            (e) =>
              (showHidden || !e.name.startsWith(".")) &&
              (!filter ||
                e.name.toLowerCase().includes(filter.toLowerCase())),
          )
          .map((entry) => (
            <TreeNode
              key={entry.path}
              entry={entry}
              depth={0}
              git={git}
              ops={fileOps}
              onNavigateRoot={onNavigateRoot}
              onOpenFile={onOpenFile}
              onCdHere={onCdHere}
              onReveal={onReveal}
              onNewTerminalHere={onNewTerminalHere}
              onParentReload={reload}
            />
          ))}
      </div>
    </div>
  );
}

interface NodeProps {
  entry: DirEntry;
  depth: number;
  git: GitStatus;
  ops: FileOps;
  onNavigateRoot: (path: string) => void;
  onOpenFile: (path: string) => void;
  onCdHere: (path: string) => void;
  onReveal: (path: string) => void;
  onNewTerminalHere: (path: string) => void;
  onParentReload: () => void;
}

function TreeNode({
  entry,
  depth,
  git,
  ops,
  onNavigateRoot,
  onOpenFile,
  onCdHere,
  onReveal,
  onNewTerminalHere,
  onParentReload,
}: NodeProps) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const loadChildren = useCallback(() => {
    listDir(entry.path)
      .then(setChildren)
      .catch((e) => alertDialog(String(e)));
  }, [entry.path]);

  // While expanded, keep this folder's children in sync with disk.
  useEffect(() => {
    if (!open || !entry.is_dir) return;
    const timer = setInterval(loadChildren, 3000);
    return () => clearInterval(timer);
  }, [open, entry.is_dir, loadChildren]);

  const toggle = () => {
    if (!entry.is_dir) {
      onOpenFile(entry.path);
      return;
    }
    if (!open && children === null) loadChildren();
    setOpen((o) => !o);
  };

  const newChild = async (isDir: boolean) => {
    const name = await promptDialog(
      isDir ? "New folder name" : "New file name",
    );
    if (!name) return;
    try {
      await (isDir
        ? createDir(join(entry.path, name))
        : createFile(join(entry.path, name)));
      if (!open) setOpen(true);
      loadChildren();
    } catch (e) {
      await alertDialog(String(e));
    }
  };

  const rename = async () => {
    const next = await promptDialog("Rename to", entry.name);
    if (!next || next === entry.name) return;
    try {
      await renamePath(entry.path, join(dirname(entry.path), next));
      onParentReload();
    } catch (e) {
      await alertDialog(String(e));
    }
  };

  const remove = async () => {
    if (!(await confirmDialog(`Delete "${entry.name}"?`))) return;
    try {
      await deletePath(entry.path);
      onParentReload();
    } catch (e) {
      await alertDialog(String(e));
    }
  };

  const menuItems = (): MenuItem[] => {
    const items: MenuItem[] = [];
    if (entry.is_dir) {
      items.push({ label: "Open as Root", onClick: () => onNavigateRoot(entry.path) });
      items.push({ label: "Open in terminal (cd)", onClick: () => onCdHere(entry.path) });
      items.push({
        label: "New Terminal Here",
        onClick: () => onNewTerminalHere(entry.path),
      });
      items.push({ label: "New File…", onClick: () => newChild(false) });
      items.push({ label: "New Folder…", onClick: () => newChild(true) });
      if (ops.clip) {
        items.push({
          label: ops.clip.cut ? "Paste (move) Here" : "Paste Here",
          onClick: () => {
            if (!open) setOpen(true);
            ops.onPaste(entry.path, loadChildren);
          },
        });
      }
      items.push({
        label: ops.bookmarks.includes(entry.path)
          ? "Remove Bookmark"
          : "Bookmark",
        onClick: () => ops.onToggleBookmark(entry.path),
      });
    } else {
      items.push({ label: "Open", onClick: () => onOpenFile(entry.path) });
    }
    items.push({
      label: "Copy",
      separator: true,
      onClick: () => ops.onCopy(entry.path),
    });
    items.push({ label: "Cut", onClick: () => ops.onCut(entry.path) });
    items.push({
      label: "Duplicate",
      onClick: () => ops.onDuplicate(entry.path, onParentReload),
    });
    items.push({
      label: "Reveal in Finder",
      separator: true,
      onClick: () => onReveal(entry.path),
    });
    items.push({
      label: "Copy Path",
      onClick: () => navigator.clipboard?.writeText(entry.path),
    });
    items.push({ label: "Rename…", onClick: rename });
    items.push({ label: "Delete", danger: true, onClick: remove });
    return items;
  };

  return (
    <div>
      <div
        className="fb-row"
        style={{ paddingLeft: depth * 14 + 6 }}
        onClick={toggle}
        onDoubleClick={() => {
          if (entry.is_dir) onNavigateRoot(entry.path);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <span className="fb-icon">
          <FileIcon name={entry.name} isDir={entry.is_dir} open={open} />
        </span>
        <span className="fb-name">{entry.name}</span>
        {(() => {
          const status = git[entry.path];
          if (status) {
            const { mark, cls } = gitBadge(status);
            return <span className={`fb-git ${cls}`}>{mark}</span>;
          }
          if (entry.is_dir && dirDirty(entry.path, git)) {
            return <span className="fb-git changed">•</span>;
          }
          return null;
        })()}
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems()}
          onClose={() => setMenu(null)}
        />
      )}
      {entry.is_dir &&
        open &&
        children
          ?.filter((c) => ops.showHidden || !c.name.startsWith("."))
          .map((child) => (
            <TreeNode
              key={child.path}
              entry={child}
              depth={depth + 1}
              git={git}
              ops={ops}
              onNavigateRoot={onNavigateRoot}
              onOpenFile={onOpenFile}
              onCdHere={onCdHere}
              onReveal={onReveal}
              onNewTerminalHere={onNewTerminalHere}
              onParentReload={loadChildren}
            />
          ))}
    </div>
  );
}
