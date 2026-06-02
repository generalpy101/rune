//! Cross-platform process helpers.
//!
//! The agent spawns shell commands, kills whole process trees (Stop / timeout),
//! and looks up a shell's working directory. The mechanics differ per OS:
//!   * unix    — `$SHELL -lc`, POSIX process groups + `killpg`, `lsof` for cwd.
//!   * windows — `cmd /C`, `CREATE_NEW_PROCESS_GROUP` + `taskkill /T`, no cwd.
//! Everything platform-specific is funnelled through here so the command code in
//! `ai.rs` stays clean and the rest of the app is OS-agnostic.

use std::process::{Command, Stdio};

#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
#[cfg(windows)]
use std::os::windows::process::CommandExt as _;

/// New process group so the whole descendant tree can be signalled at once.
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

/// Build a `Command` that runs `command` through the platform's shell, in `cwd`,
/// with stdin closed and stdout/stderr piped, placed in its own process group so
/// the entire tree (npm → node, etc.) can be killed later. The caller spawns it.
pub fn shell_command(command: &str, cwd: &str) -> Command {
    #[cfg(unix)]
    {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let mut c = Command::new(shell);
        c.arg("-lc")
            .arg(command)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // pgid == child pid, so killpg(pid) reaches every descendant.
        c.process_group(0);
        c
    }
    #[cfg(windows)]
    {
        let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());
        let mut c = Command::new(comspec);
        c.arg("/C")
            .arg(command)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        c.creation_flags(CREATE_NEW_PROCESS_GROUP);
        c
    }
}

/// Signal an entire process tree by its group id (== the spawned child's pid).
/// `force` escalates to an unconditional kill (SIGKILL / `taskkill /F`); without
/// it we ask politely (SIGTERM / `taskkill` soft) so the process can clean up.
/// "No such process" is ignored — the tree may already be gone.
pub fn kill_group(pgid: i32, force: bool) {
    if pgid <= 1 {
        return;
    }
    #[cfg(unix)]
    unsafe {
        let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
        libc::killpg(pgid, sig);
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/PID", &pgid.to_string(), "/T"]);
        if force {
            cmd.arg("/F");
        }
        let _ = cmd.output();
    }
}

/// Post a native desktop notification. macOS uses AppleScript (`osascript`),
/// Linux uses `notify-send`; Windows is a no-op for now. Best-effort: any
/// failure (tool missing, permission denied) is silently ignored.
#[allow(unused_variables)]
pub fn os_notify(title: &str, body: &str) {
    #[cfg(target_os = "macos")]
    {
        let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
        let script = format!(
            "display notification \"{}\" with title \"{}\"",
            esc(body),
            esc(title)
        );
        let _ = Command::new("osascript").arg("-e").arg(script).output();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = Command::new("notify-send").arg(title).arg(body).output();
    }
}

/// Best-effort lookup of a process's current working directory. Used so the file
/// browser can follow the terminal as the user `cd`s. Returns `None` when it
/// can't be determined (process gone, or unsupported OS).
#[cfg(unix)]
pub fn process_cwd(pid: u32) -> Option<String> {
    let out = Command::new("lsof")
        .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .find_map(|l| l.strip_prefix('n').map(|s| s.to_string()))
}

/// Windows has no cheap, dependency-free equivalent of `lsof -d cwd`, so the
/// file browser simply won't auto-follow `cd` there. Manual navigation still works.
#[cfg(windows)]
pub fn process_cwd(_pid: u32) -> Option<String> {
    None
}
