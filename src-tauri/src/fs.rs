use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;

use serde::Serialize;

#[derive(Serialize)]
pub struct DirEntry {
    name: String,
    path: String,
    is_dir: bool,
}

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let mut entries = Vec::new();
    for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
        entries.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    // Directories first, then alphabetical (case-insensitive).
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then(a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    fs::write(&path, contents).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    if Path::new(&path).exists() {
        return Err("path already exists".into());
    }
    fs::write(&path, "").map_err(|e| e.to_string())
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn move_path(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| e.to_string())
}

/// Recursively copy a file or directory from `from` to `to`.
#[tauri::command]
pub fn copy_path(from: String, to: String) -> Result<(), String> {
    copy_recursive(Path::new(&from), Path::new(&to)).map_err(|e| e.to_string())
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst)?;
    }
    Ok(())
}

/// A non-colliding destination path for a "Duplicate" action: appends
/// ` copy`, ` copy 2`, … before the extension until the path is free.
#[tauri::command]
pub fn duplicate_path(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let parent = p.parent().unwrap_or_else(|| Path::new("/"));
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy()));
    for n in 1..1000 {
        let suffix = if n == 1 { " copy".to_string() } else { format!(" copy {n}") };
        let name = match &ext {
            Some(ext) if !p.is_dir() => format!("{stem}{suffix}{ext}"),
            _ => format!("{stem}{suffix}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            copy_recursive(p, &candidate).map_err(|e| e.to_string())?;
            return Ok(candidate.to_string_lossy().into_owned());
        }
    }
    Err("could not find a free duplicate name".into())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn home_dir() -> Result<String, String> {
    std::env::var("HOME").map_err(|_| "HOME is not set".to_string())
}

/// Reveal a file or folder in macOS Finder (selects it in its parent window).
#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), String> {
    Command::new("open")
        .arg("-R")
        .arg(&path)
        .status()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Current git branch (or short commit when detached) for the repo containing
/// `path`. `None` when the path isn't inside a git repository.
#[tauri::command]
pub fn git_branch(path: String) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() {
        None
    } else if branch == "HEAD" {
        // Detached: fall back to the short commit hash.
        Command::new("git")
            .arg("-C")
            .arg(&path)
            .args(["rev-parse", "--short", "HEAD"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        Some(branch)
    }
}

/// Contents of `path` as committed at HEAD, for diffing the working tree
/// against the last commit. Returns an empty string when the file is new /
/// untracked (no HEAD version), and an error only when `path` isn't inside a
/// git repository.
#[tauri::command]
pub fn git_file_head(path: String) -> Result<String, String> {
    let dir = Path::new(&path)
        .parent()
        .ok_or_else(|| "path has no parent directory".to_string())?;

    let top_out = Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|e| e.to_string())?;
    if !top_out.status.success() {
        return Err("not a git repository".to_string());
    }
    let top = String::from_utf8_lossy(&top_out.stdout).trim().to_string();

    // Path relative to the repo root, with canonicalization so symlinked
    // roots (e.g. /tmp on macOS) still match.
    let canon = fs::canonicalize(&path).map_err(|e| e.to_string())?;
    let top_canon = fs::canonicalize(&top).map_err(|e| e.to_string())?;
    let rel = canon
        .strip_prefix(&top_canon)
        .map_err(|_| "file is not inside the repository".to_string())?
        .to_string_lossy()
        .replace('\\', "/");

    let out = Command::new("git")
        .arg("-C")
        .arg(&top)
        .arg("show")
        .arg(format!("HEAD:{}", rel))
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        // No HEAD version (new/untracked file): diff against empty.
        return Ok(String::new());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Show a native OS notification (used for "notify when a long command
/// finishes" while the window is unfocused). Best-effort; failures are ignored.
#[tauri::command]
pub fn notify(title: String, body: String) {
    crate::platform::os_notify(&title, &body);
}

/// Directories that are skipped while walking — large/noisy and rarely useful
/// for quick-open.
const SKIP_DIRS: [&str; 8] = [
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".cache",
    "vendor",
];

/// Recursively collect file paths (absolute) under `root` for the fuzzy file
/// finder. Skips heavy directories and hidden directories, bounds depth and
/// total count to stay fast on large trees.
#[tauri::command]
pub fn walk_dir(root: String) -> Result<Vec<String>, String> {
    const MAX_FILES: usize = 20_000;
    const MAX_DEPTH: usize = 12;
    let mut out = Vec::new();
    let mut stack = vec![(std::path::PathBuf::from(&root), 0usize)];

    while let Some((dir, depth)) = stack.pop() {
        if out.len() >= MAX_FILES {
            break;
        }
        let rd = match fs::read_dir(&dir) {
            Ok(rd) => rd,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let is_dir = entry.file_type().map(|t| t.is_dir()).unwrap_or(false);
            if is_dir {
                if depth + 1 > MAX_DEPTH
                    || name.starts_with('.')
                    || SKIP_DIRS.contains(&name.as_str())
                {
                    continue;
                }
                stack.push((entry.path(), depth + 1));
            } else {
                out.push(entry.path().to_string_lossy().into_owned());
                if out.len() >= MAX_FILES {
                    break;
                }
            }
        }
    }
    Ok(out)
}

/// Map of absolute file path -> git status category for the repo containing
/// `path`. Returns an empty map when `path` is not inside a git repository.
#[tauri::command]
pub fn git_status(path: String) -> Result<HashMap<String, String>, String> {
    let mut map = HashMap::new();

    let top_out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    let top = match top_out {
        Ok(o) if o.status.success() => {
            String::from_utf8_lossy(&o.stdout).trim().to_string()
        }
        _ => return Ok(map), // not a git repo
    };

    let out = Command::new("git")
        .arg("-C")
        .arg(&path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Ok(map);
    }

    for line in String::from_utf8_lossy(&out.stdout).lines() {
        if line.len() < 4 {
            continue;
        }
        let code = &line[..2];
        let mut rel = line[3..].to_string();
        // Renames are "old -> new"; keep the new path.
        if let Some(idx) = rel.find(" -> ") {
            rel = rel[idx + 4..].to_string();
        }
        let rel = rel.trim().trim_matches('"').trim_end_matches('/');
        let abs = format!("{}/{}", top, rel);

        let category = if code.contains('?') {
            "untracked"
        } else if code.contains('D') {
            "deleted"
        } else if code.contains('A') {
            "added"
        } else if code.contains('M') || code.contains('R') {
            "modified"
        } else {
            "changed"
        };
        map.insert(abs, category.to_string());
    }

    Ok(map)
}
