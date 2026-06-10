use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
// `OnceLock` is only used by the Unix-only shell-integration shims below.
#[cfg(unix)]
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

/// How many bytes of recent PTY output we retain per session so a reattaching
/// frontend (e.g. after a dev-server reload) can repaint the current screen.
const REPLAY_CAP: usize = 256 * 1024;

/// OSC identifier the `rt` shell integration emits. Must match `META_OSC` in
/// the frontend (`src/lib/meta.ts`).
const META_OSC: u32 = 7000;

/// Lazily create a tiny `rt` executable in a temp dir and return that dir, so
/// it can be prepended to the spawned shell's PATH. This makes `rt …` a normal
/// command — no shell function typed into the PTY, so nothing is echoed at
/// startup, and it works uniformly across zsh/bash/fish/sh. Unix only.
#[cfg(unix)]
fn rt_shim_dir() -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    static DIR: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("rune-bin");
        std::fs::create_dir_all(&dir).ok()?;
        let script = dir.join("rt");
        let body = format!("#!/bin/sh\nprintf '\\033]{};%s\\007' \"$*\"\n", META_OSC);
        std::fs::write(&script, body).ok()?;
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).ok()?;
        Some(dir)
    })
    .clone()
}

#[cfg(not(unix))]
fn rt_shim_dir() -> Option<std::path::PathBuf> {
    None
}

/// Lazily materialize a private `ZDOTDIR` whose startup files (a) load the
/// user's real zsh config and (b) install OSC 133 hooks that mark command
/// boundaries (prompt start `A`, prompt end `B`, command start `C`, command
/// done `D;<exit>`). The frontend turns these into clickable command blocks,
/// status gutter marks and prompt-jump navigation. Pointed at via the `ZDOTDIR`
/// env var; the user's original dir is passed through `RT_USER_ZDOTDIR`. Unix.
#[cfg(unix)]
fn osc133_zsh_dir() -> Option<std::path::PathBuf> {
    static DIR: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    DIR.get_or_init(|| {
        let dir = std::env::temp_dir().join("rune-zsh");
        std::fs::create_dir_all(&dir).ok()?;
        // Each non-rc startup file re-sources the user's equivalent, but with
        // ZDOTDIR temporarily restored to the user's value *around* the source —
        // otherwise plugin managers / compinit / oh-my-zsh that resolve paths
        // off $ZDOTDIR (completions, autosuggestions) load from our temp dir and
        // silently break. We snapshot our dir, point ZDOTDIR back at the user's
        // for the source, then restore ours so zsh keeps reading the remaining
        // startup files (incl. our .zshrc) from here. (VS Code's approach.)
        let passthrough = |name: &str| {
            format!(
                "__rune_zd=\"$ZDOTDIR\"\n\
                 if [ -n \"$RT_USER_ZDOTDIR\" ] && [ -f \"$RT_USER_ZDOTDIR/{name}\" ]; then\n\
                 \x20 ZDOTDIR=\"$RT_USER_ZDOTDIR\"\n\
                 \x20 source \"$RT_USER_ZDOTDIR/{name}\"\n\
                 \x20 ZDOTDIR=\"$__rune_zd\"\n\
                 fi\n"
            )
        };
        std::fs::write(dir.join(".zshenv"), passthrough(".zshenv")).ok()?;
        std::fs::write(dir.join(".zprofile"), passthrough(".zprofile")).ok()?;
        std::fs::write(dir.join(".zlogin"), passthrough(".zlogin")).ok()?;
        // .zshrc: load the user's config with the correct ZDOTDIR, then install
        // the OSC 133 hooks and append the zero-width `B` marker to the prompt.
        // We leave ZDOTDIR pointed back at the user's dir afterwards so runtime
        // references resolve correctly (and a login shell reads the user's
        // .zlogin directly).
        let zshrc = "\
__rune_zd=\"$ZDOTDIR\"
if [ -n \"$RT_USER_ZDOTDIR\" ] && [ -f \"$RT_USER_ZDOTDIR/.zshrc\" ]; then
  ZDOTDIR=\"$RT_USER_ZDOTDIR\"
  source \"$RT_USER_ZDOTDIR/.zshrc\"
fi

# --- Rune OSC 133 command-block integration ---
autoload -Uz add-zsh-hook 2>/dev/null
__rt_executing=\"\"
__rt_precmd() {
  local ret=$?
  [ -n \"$__rt_executing\" ] && printf '\\033]133;D;%s\\007' \"$ret\"
  printf '\\033]133;A\\007'
  __rt_executing=\"\"
}
__rt_preexec() {
  printf '\\033]133;C\\007'
  __rt_executing=\"1\"
}
add-zsh-hook precmd __rt_precmd
add-zsh-hook preexec __rt_preexec
PS1=\"${PS1}%{$(printf '\\033]133;B\\007')%}\"
# Hand ZDOTDIR back to the user's value for the rest of the session.
[ -n \"$RT_USER_ZDOTDIR\" ] && export ZDOTDIR=\"$RT_USER_ZDOTDIR\"
";
        std::fs::write(dir.join(".zshrc"), zshrc).ok()?;
        Some(dir)
    })
    .clone()
}

/// Lazily materialize a bash rc file that sources the user's `~/.bashrc` then
/// installs OSC 133 hooks (via `PROMPT_COMMAND` + a `DEBUG` trap). Launched with
/// `bash --rcfile <this>`. Unix.
#[cfg(unix)]
fn osc133_bash_rcfile() -> Option<std::path::PathBuf> {
    static FILE: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    FILE.get_or_init(|| {
        let dir = std::env::temp_dir().join("rune-bash");
        std::fs::create_dir_all(&dir).ok()?;
        let rc = "\
# This is a non-login interactive bash; also load the login profile so PATH set
# there (e.g. Homebrew on macOS) is available, then the user's bashrc.
for __rt_p in \"$HOME/.bash_profile\" \"$HOME/.bash_login\" \"$HOME/.profile\"; do
  [ -f \"$__rt_p\" ] && { . \"$__rt_p\"; break; }
done
unset __rt_p
[ -f ~/.bashrc ] && source ~/.bashrc

# --- Rune OSC 133 command-block integration ---
__rt_executing=\"\"
__rt_preexec() {
  [ -n \"$COMP_LINE\" ] && return
  [ \"$BASH_COMMAND\" = \"$PROMPT_COMMAND\" ] && return
  if [ -z \"$__rt_executing\" ]; then
    printf '\\033]133;C\\007'
    __rt_executing=\"1\"
  fi
}
trap '__rt_preexec' DEBUG
__rt_precmd() {
  local ret=$?
  [ -n \"$__rt_executing\" ] && printf '\\033]133;D;%s\\007' \"$ret\"
  printf '\\033]133;A\\007'
  __rt_executing=\"\"
}
PROMPT_COMMAND=\"__rt_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}\"
PS1=\"${PS1}\\[\\033]133;B\\007\\]\"
";
        let path = dir.join("rt-bashrc");
        std::fs::write(&path, rc).ok()?;
        Some(path)
    })
    .clone()
}

/// The user's default shell program. Prefer `$SHELL`, then common fallbacks.
///
/// We resolve this to an explicit path instead of using
/// `CommandBuilder::new_default_prog()` because portable-pty PANICS if any args
/// are later added to a default-prog builder ("attempted to add args to a
/// default_prog builder"). The bash shell-integration path adds `--rcfile`, so
/// on Unix the builder must always carry an explicit program. (Running `$SHELL`
/// with no args is equivalent to portable-pty's default-prog behaviour.)
#[cfg(unix)]
fn default_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| {
            for p in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
                if std::path::Path::new(p).exists() {
                    return p.to_string();
                }
            }
            "/bin/sh".to_string()
        })
}

/// How to launch an agent CLI (e.g. `codex`) in a terminal.
#[derive(serde::Serialize)]
pub struct AgentLaunch {
    pub shell: String,
    pub args: Vec<String>,
}

/// Resolve how to launch an agent CLI by name, using the user's real shell
/// environment. GUI apps inherit a minimal PATH, and CLIs like Codex are
/// usually installed via npm-global / Homebrew paths that aren't on it — so we
/// run the command through the user's login+interactive shell (which sources
/// their profile/rc and sets PATH, and lets the CLI pick up its own auth).
/// Returns `None` when the command isn't found in that environment, so the UI
/// can prompt the user to install it.
#[tauri::command]
pub fn agent_spawn(command: String) -> Option<AgentLaunch> {
    // This name is interpolated into a shell command; allow only simple,
    // safe command names so it can't break out of the `exec`.
    if command.is_empty()
        || !command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return None;
    }

    #[cfg(unix)]
    {
        let shell = default_shell();
        // Available in the user's login+interactive shell?
        let found = std::process::Command::new(&shell)
            .args(["-lic", &format!("command -v {} >/dev/null 2>&1", command)])
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !found {
            return None;
        }
        Some(AgentLaunch {
            shell,
            args: vec!["-lic".into(), format!("exec {}", command)],
        })
    }

    #[cfg(not(unix))]
    {
        let found = std::process::Command::new("where")
            .arg(&command)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        if !found {
            return None;
        }
        Some(AgentLaunch {
            shell: command,
            args: Vec::new(),
        })
    }
}

/// Optional overrides for what a terminal runs, from a saved profile. When
/// absent everywhere, the user's default login shell is used.
#[derive(Deserialize, Default)]
pub struct SpawnProfile {
    /// Program to launch (absolute path or a name on PATH). `None` = default shell.
    pub shell: Option<String>,
    /// Arguments passed to the shell (e.g. `["-l"]`, or `["-NoLogo"]` for PowerShell).
    #[serde(default)]
    pub args: Vec<String>,
    /// Extra environment variables layered on top of the inherited environment.
    #[serde(default)]
    pub env: HashMap<String, String>,
}

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    /// Kills the child on close/quit. The `Child` itself is owned by a wait
    /// thread (so it can report the exit code), so we keep only a killer here.
    killer: Box<dyn ChildKiller + Send + Sync>,
    pid: Option<u32>,
    /// The Channel the reader thread currently streams to. Swapped on reattach
    /// so a freshly-loaded webview takes over the live PTY instead of spawning
    /// a new shell. The reader thread reads this each iteration.
    out: Arc<Mutex<Option<Channel<String>>>>,
    /// Bounded buffer of recent raw output bytes, replayed on reattach.
    replay: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
pub struct PtyManager {
    sessions: Mutex<HashMap<u32, PtySession>>,
    next_id: Mutex<u32>,
}

#[tauri::command]
pub fn pty_spawn(
    rows: u16,
    cols: u16,
    cwd: Option<String>,
    profile: Option<SpawnProfile>,
    // When true, make `rt` available on PATH for in-terminal meta-commands.
    integration: Option<bool>,
    on_data: Channel<String>,
    app: AppHandle,
    state: State<'_, PtyManager>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    let profile = profile.unwrap_or_default();

    // A profile can pin a specific shell + args; otherwise use the user's
    // default login shell (cmd.exe / $SHELL, picked by portable-pty per OS).
    let mut cmd = match &profile.shell {
        Some(shell) if !shell.trim().is_empty() => {
            let mut c = CommandBuilder::new(shell);
            for arg in &profile.args {
                c.arg(arg);
            }
            c
        }
        // On Unix, resolve the default shell to an explicit program (portable-pty
        // panics if args are added to a default-prog builder) and spawn it as a
        // LOGIN shell, so it reads the user's profile (~/.zprofile,
        // ~/.bash_profile) — that's where macOS Homebrew & friends put PATH, so a
        // non-login shell leaves `brew` (and other profile PATH entries) missing.
        // Exception: bash with shell-integration uses `--rcfile` (added below),
        // which a *login* bash ignores — so it stays non-login and that rcfile
        // sources the login profile itself.
        #[cfg(unix)]
        _ => {
            let shell = default_shell();
            let base = std::path::Path::new(&shell)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let mut c = CommandBuilder::new(&shell);
            if !(base == "bash" && integration.unwrap_or(false)) {
                c.arg("-l");
            }
            c
        }
        #[cfg(not(unix))]
        _ => CommandBuilder::new_default_prog(),
    };

    // Inherit the environment so PATH and friends are available, then layer the
    // profile's own variables on top (profile wins on conflict).
    for (key, value) in std::env::vars() {
        cmd.env(key, value);
    }
    cmd.env("TERM", "xterm-256color");
    for (key, value) in &profile.env {
        cmd.env(key, value);
    }

    // Shell integration: prepend a temp dir holding an `rt` executable so
    // in-terminal meta-commands work without typing a shell function into the
    // PTY (which would otherwise echo on every shell start).
    if integration.unwrap_or(false) {
        if let Some(shim) = rt_shim_dir() {
            let base = profile
                .env
                .get("PATH")
                .cloned()
                .or_else(|| std::env::var("PATH").ok())
                .unwrap_or_default();
            let path = if base.is_empty() {
                shim.display().to_string()
            } else {
                format!("{}:{}", shim.display(), base)
            };
            cmd.env("PATH", path);
        }

        // OSC 133 command-block markers: configure the spawned shell to source
        // hook scripts that emit prompt/command boundaries. Detect the shell
        // from the profile or `$SHELL`; only zsh and bash are wired (others —
        // including `ssh` for SSH-host tabs — are left untouched).
        #[cfg(unix)]
        {
            let program = profile
                .shell
                .clone()
                .filter(|s| !s.trim().is_empty())
                .or_else(|| std::env::var("SHELL").ok())
                .unwrap_or_default();
            let base = std::path::Path::new(&program)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("");
            match base {
                "zsh" => {
                    if let Some(zdir) = osc133_zsh_dir() {
                        let user = std::env::var("ZDOTDIR")
                            .ok()
                            .filter(|s| !s.is_empty())
                            .unwrap_or_else(|| {
                                std::env::var("HOME").unwrap_or_default()
                            });
                        cmd.env("RT_USER_ZDOTDIR", user);
                        cmd.env("ZDOTDIR", zdir.display().to_string());
                    }
                }
                "bash" => {
                    if let Some(rc) = osc133_bash_rcfile() {
                        cmd.arg("--rcfile");
                        cmd.arg(rc.display().to_string());
                    }
                }
                _ => {}
            }
        }
    }

    if let Some(dir) = cwd {
        cmd.cwd(dir);
    }

    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let pid = child.process_id();
    // Keep a killer so close/quit can terminate the child; the `Child` itself
    // moves into a wait thread below so it can report the exit code.
    let killer = child.clone_killer();
    // The slave handle is owned by the spawned child now.
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let id = {
        let mut next = state.next_id.lock().unwrap();
        *next += 1;
        *next
    };

    // Wait for the child to exit on a dedicated thread, then notify the
    // frontend with the exit code so it can close (clean exit) or keep the
    // pane open showing the error (abnormal exit).
    let exit_app = app.clone();
    std::thread::spawn(move || {
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        let _ = exit_app.emit(&format!("pty-exit-{id}"), code);
    });

    let out = Arc::new(Mutex::new(Some(on_data)));
    let replay = Arc::new(Mutex::new(Vec::<u8>::new()));

    // Stream raw PTY bytes to the frontend, base64-encoded so partial UTF-8
    // sequences split across reads are never corrupted. The output Channel is
    // held behind a Mutex so `pty_attach` can swap in a new one without
    // disturbing the shell — the thread re-reads it every iteration.
    let thread_out = Arc::clone(&out);
    let thread_replay = Arc::clone(&replay);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    {
                        // Keep a bounded tail of output for replay-on-reattach.
                        let mut rb = thread_replay.lock().unwrap();
                        rb.extend_from_slice(chunk);
                        if rb.len() > REPLAY_CAP {
                            let drop = rb.len() - REPLAY_CAP;
                            rb.drain(..drop);
                        }
                    }
                    let encoded = STANDARD.encode(chunk);
                    // Send if a frontend is attached. A send error (channel
                    // closed by a reloading webview) is non-fatal: keep the
                    // shell alive so it can be reattached.
                    if let Some(ch) = thread_out.lock().unwrap().as_ref() {
                        let _ = ch.send(encoded);
                    }
                }
                Err(_) => break,
            }
        }
    });

    state.sessions.lock().unwrap().insert(
        id,
        PtySession {
            master: pair.master,
            writer,
            killer,
            pid,
            out,
            replay,
        },
    );

    Ok(id)
}

/// Reattach a (reloaded) frontend to a still-running PTY session: swap in the
/// new output Channel, resize to the current viewport, and replay the recent
/// output so the terminal repaints to the live screen state. Returns `false`
/// if the session no longer exists (caller should spawn a fresh one).
#[tauri::command]
pub fn pty_attach(
    id: u32,
    rows: u16,
    cols: u16,
    on_data: Channel<String>,
    state: State<'_, PtyManager>,
) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(session) = sessions.get(&id) else {
        return false;
    };

    // Replay buffered output first so the new channel paints the current screen
    // before any new live bytes arrive.
    {
        let rb = session.replay.lock().unwrap();
        if !rb.is_empty() {
            let _ = on_data.send(STANDARD.encode(&rb[..]));
        }
    }

    *session.out.lock().unwrap() = Some(on_data);

    let _ = session.master.resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });

    true
}

/// Best-effort lookup of the shell's current working directory so the file
/// browser can follow the terminal as the user `cd`s around. Returns `None`
/// when it can't be determined (process gone, or unsupported platform).
#[tauri::command]
pub fn pty_cwd(id: u32, state: State<'_, PtyManager>) -> Option<String> {
    let pid = {
        let sessions = state.sessions.lock().unwrap();
        sessions.get(&id)?.pid?
    };
    crate::platform::process_cwd(pid)
}

/// Whether a foreground command (other than the shell itself) is currently
/// running in this PTY. Determined by comparing the tty's foreground process
/// group with the shell's pid — no shell cooperation required. Always `false`
/// on platforms without `tcgetpgrp` support (e.g. Windows).
#[tauri::command]
pub fn pty_busy(id: u32, state: State<'_, PtyManager>) -> bool {
    let sessions = state.sessions.lock().unwrap();
    let Some(session) = sessions.get(&id) else {
        return false;
    };
    // `process_group_leader` (tcgetpgrp) is Unix-only in portable-pty; Windows
    // has no equivalent, so we conservatively report "not busy" there.
    #[cfg(unix)]
    {
        match (session.master.process_group_leader(), session.pid) {
            (Some(fg), Some(pid)) => fg as i64 != pid as i64,
            _ => false,
        }
    }
    #[cfg(not(unix))]
    {
        let _ = &session;
        false
    }
}

#[tauri::command]
pub fn pty_write(id: u32, data: String, state: State<'_, PtyManager>) -> Result<(), String> {
    let mut sessions = state.sessions.lock().unwrap();
    let session = sessions.get_mut(&id).ok_or("pty session not found")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_resize(
    id: u32,
    rows: u16,
    cols: u16,
    state: State<'_, PtyManager>,
) -> Result<(), String> {
    let sessions = state.sessions.lock().unwrap();
    let session = sessions.get(&id).ok_or("pty session not found")?;
    session
        .master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pty_kill(id: u32, state: State<'_, PtyManager>) -> Result<(), String> {
    if let Some(mut session) = state.sessions.lock().unwrap().remove(&id) {
        let _ = session.killer.kill();
    }
    Ok(())
}
