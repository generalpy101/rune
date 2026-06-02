//! System activity monitor. Independent of the agent-command registry in
//! `ai.rs`: this inspects the *whole machine* so the user can find and kill
//! stray dev servers / processes holding onto TCP ports — even ones this app
//! never launched (a `next dev` left running in another terminal, a crashed
//! server still bound to :3000, etc.).
//!
//! Port inventory + termination are OS-specific:
//!   * unix    — `lsof -F` for listening sockets, `libc` signals to terminate.
//!   * windows — `netstat -ano` + `tasklist` for the inventory, `taskkill /T`.

use serde::Serialize;

/// One process listening on a TCP port. Multiple rows can share a pid when a
/// server binds several ports (or both IPv4 and IPv6 — those are de-duplicated
/// to a single row per pid+port).
#[derive(Serialize)]
pub struct PortInfo {
    pub pid: i32,
    /// Executable / command name (e.g. `node`, `python`, `node.exe`).
    pub command: String,
    /// Owning user login name (empty on Windows, where it's costly to resolve).
    pub user: String,
    /// Bind address: `*` (all interfaces), `127.0.0.1`, `[::1]`, etc.
    pub address: String,
    pub port: u16,
}

/// Enumerate every process listening on a TCP port. Powers the system activity
/// monitor's "ports" view. Returns an empty list (not an error) when nothing is
/// listening.
#[tauri::command]
pub fn list_listening_ports() -> Result<Vec<PortInfo>, String> {
    let mut results = list_ports_impl()?;
    results.sort_by(|a, b| a.port.cmp(&b.port).then(a.pid.cmp(&b.pid)));
    Ok(results)
}

/// Terminate a process by pid to free its port. Asks politely first, then forces
/// the kill after a short grace period so well-behaved servers can shut down
/// cleanly but stuck ones still die. Returns immediately; the forced backstop
/// runs on a detached thread.
#[tauri::command]
pub fn kill_process(pid: i32) -> Result<(), String> {
    if pid <= 1 {
        return Err("refusing to signal pid <= 1".into());
    }
    signal_process(pid, false);
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        signal_process(pid, true);
    });
    Ok(())
}

// ───────────────────────────── unix ─────────────────────────────

#[cfg(unix)]
fn list_ports_impl() -> Result<Vec<PortInfo>, String> {
    use std::process::Command;

    // -iTCP + -sTCP:LISTEN → only listening TCP sockets.
    // -P -n → numeric ports and addresses (no DNS / service lookups; fast).
    // -F cLn → machine-readable: command, login name, and name fields.
    let out = Command::new("lsof")
        .args(["-iTCP", "-sTCP:LISTEN", "-P", "-n", "-FcLn"])
        .output()
        .map_err(|e| format!("failed to run lsof: {e}"))?;

    let text = String::from_utf8_lossy(&out.stdout);
    let mut results: Vec<PortInfo> = Vec::new();
    // Process-level fields persist across the file (`n`) lines that follow them.
    let mut pid: i32 = 0;
    let mut command = String::new();
    let mut user = String::new();

    for line in text.lines() {
        let Some((tag, val)) = split_field(line) else {
            continue;
        };
        match tag {
            'p' => pid = val.parse().unwrap_or(0),
            'c' => command = val.to_string(),
            'L' => user = val.to_string(),
            'n' => {
                if let Some((address, port)) = parse_addr_port(val) {
                    let dup = results.iter().any(|r| r.pid == pid && r.port == port);
                    if !dup {
                        results.push(PortInfo {
                            pid,
                            command: command.clone(),
                            user: user.clone(),
                            address,
                            port,
                        });
                    }
                }
            }
            _ => {}
        }
    }
    Ok(results)
}

/// Split a one-char-tagged `lsof -F` line into (tag, value). `None` for empties.
#[cfg(unix)]
fn split_field(line: &str) -> Option<(char, &str)> {
    let mut chars = line.chars();
    let tag = chars.next()?;
    Some((tag, &line[tag.len_utf8()..]))
}

/// Parse an `lsof` NAME value for a listening socket into `(address, port)`.
/// Handles `*:3000`, `127.0.0.1:8080`, `[::1]:5173`, `[::]:9229`.
#[cfg(unix)]
fn parse_addr_port(name: &str) -> Option<(String, u16)> {
    let idx = name.rfind(':')?;
    let (addr, port) = name.split_at(idx);
    let port: u16 = port[1..].parse().ok()?;
    Some((addr.to_string(), port))
}

/// Send a termination signal to a pid, preferring its process group so a whole
/// dev-server tree (`npm` → `node`) goes down together. Guards against
/// signalling our *own* group, and ignores "no such process".
#[cfg(unix)]
fn signal_process(pid: i32, force: bool) {
    if pid <= 1 {
        return;
    }
    let sig = if force { libc::SIGKILL } else { libc::SIGTERM };
    unsafe {
        let own = libc::getpgid(0);
        let target = libc::getpgid(pid);
        if target > 1 && target != own {
            libc::killpg(target, sig);
        } else {
            libc::kill(pid, sig);
        }
    }
}

// ──────────────────────────── windows ───────────────────────────

#[cfg(windows)]
fn list_ports_impl() -> Result<Vec<PortInfo>, String> {
    use std::process::Command;

    // `netstat -ano` gives proto / local / foreign / state / pid columns. We
    // keep LISTENING TCP rows and resolve pid → image name from `tasklist`.
    let out = Command::new("netstat")
        .args(["-ano", "-p", "TCP"])
        .output()
        .map_err(|e| format!("failed to run netstat: {e}"))?;
    let text = String::from_utf8_lossy(&out.stdout);
    let names = pid_names();

    let mut results: Vec<PortInfo> = Vec::new();
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        // e.g. ["TCP", "0.0.0.0:135", "0.0.0.0:0", "LISTENING", "1234"]
        if f.len() < 5 || !f[0].eq_ignore_ascii_case("TCP") || f[3] != "LISTENING" {
            continue;
        }
        let Some((address, port)) = parse_addr_port(f[1]) else {
            continue;
        };
        let pid: i32 = f[4].parse().unwrap_or(0);
        if results.iter().any(|r| r.pid == pid && r.port == port) {
            continue;
        }
        let command = names
            .get(&pid)
            .cloned()
            .unwrap_or_else(|| format!("pid {pid}"));
        results.push(PortInfo {
            pid,
            command,
            user: String::new(),
            address,
            port,
        });
    }
    Ok(results)
}

/// Snapshot of pid → image name via `tasklist /FO CSV /NH`.
#[cfg(windows)]
fn pid_names() -> std::collections::HashMap<i32, String> {
    use std::collections::HashMap;
    use std::process::Command;

    let mut map = HashMap::new();
    let Ok(out) = Command::new("tasklist").args(["/FO", "CSV", "/NH"]).output() else {
        return map;
    };
    let text = String::from_utf8_lossy(&out.stdout);
    for line in text.lines() {
        // "Image Name","PID","Session Name","Session#","Mem Usage"
        let cols: Vec<String> = line
            .split("\",\"")
            .map(|c| c.trim_matches('"').to_string())
            .collect();
        if cols.len() >= 2 {
            if let Ok(pid) = cols[1].parse::<i32>() {
                map.insert(pid, cols[0].clone());
            }
        }
    }
    map
}

#[cfg(windows)]
fn parse_addr_port(name: &str) -> Option<(String, u16)> {
    let idx = name.rfind(':')?;
    let (addr, port) = name.split_at(idx);
    let port: u16 = port[1..].parse().ok()?;
    Some((addr.to_string(), port))
}

/// Terminate a process (and its child tree) via `taskkill`. `force` adds `/F`.
#[cfg(windows)]
fn signal_process(pid: i32, force: bool) {
    use std::process::Command;
    if pid <= 1 {
        return;
    }
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T"]);
    if force {
        cmd.arg("/F");
    }
    let _ = cmd.output();
}
