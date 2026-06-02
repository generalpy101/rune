//! AI provider bridge. The frontend sends a *normalized* chat request (a list
//! of role/content messages plus tool definitions); this module translates it
//! into each provider's wire format, streams the HTTP response, and forwards
//! normalized events back over a Tauri `Channel`.
//!
//! Two adapters cover every supported provider:
//!   - `openai`  — OpenAI Chat Completions format. Also serves Ollama, LM
//!                 Studio, OpenRouter, Gemini's OpenAI-compatible endpoint, and
//!                 any custom OpenAI-compatible server.
//!   - `anthropic` — Anthropic Messages API.
//!
//! All HTTP happens in Rust (reqwest), so there are no CORS or webview-fetch
//! limitations and token streaming is reliable.

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::platform::{kill_group, shell_command};
use std::collections::HashMap;
use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::oneshot;

/// If the model sends no bytes for this long, the stream is considered hung and
/// is aborted so the agent loop can never block forever.
const STREAM_STALL_SECS: u64 = 90;

/// Coalesce streamed text deltas and forward them at most this often. A fast
/// model emits hundreds–thousands of tiny tokens/sec; sending one IPC message
/// per token saturates the webview's single main thread and freezes the whole
/// UI (terminal included). Batching cuts that to ~25 messages/sec.
const TEXT_FLUSH_MS: u128 = 50;
/// Flush early if the buffer reaches this size, so a burst still streams
/// smoothly rather than arriving in one large lump. Kept generous (a few KB) so
/// a fast burst is delivered as a handful of messages, not dozens of tiny ones.
const TEXT_FLUSH_BYTES: usize = 4096;

/// One message in the normalized conversation sent from the frontend.
#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String, // "system" | "user" | "assistant" | "tool"
    #[serde(default)]
    pub content: String,
    /// Present on assistant messages that called tools.
    #[serde(default)]
    pub tool_calls: Vec<ToolCall>,
    /// Present on `tool` messages — which call this is a result for.
    #[serde(default)]
    pub tool_call_id: Option<String>,
}

#[derive(Deserialize, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    /// JSON-encoded arguments string.
    pub arguments: String,
}

/// A tool the model may call.
#[derive(Deserialize)]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub parameters: Value, // JSON Schema
}

#[derive(Deserialize)]
pub struct ChatRequest {
    /// "openai" | "anthropic"
    pub kind: String,
    /// Base URL, e.g. "https://api.openai.com/v1" or "http://localhost:11434/v1".
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub system: Option<String>,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    /// Per-turn id so the frontend can cancel this stream via `cancel_chat`.
    #[serde(default)]
    pub id: String,
}

/// Managed state: stream id → cancel sender. Lets `cancel_chat` abort an
/// in-flight model stream (e.g. when the user hits Stop while it's hung).
#[derive(Clone, Default)]
pub struct ChatRegistry {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<()>>>>,
}

/// One iteration of the streaming select: a data chunk, end-of-stream,
/// user cancellation, or a transport error.
enum StreamStep {
    Chunk(Vec<u8>),
    End,
    Cancelled,
    Err(String),
}

/// Await the next stream event, racing it against user cancellation and an
/// inactivity timeout. Returns `Err` only on a hard timeout.
async fn next_step<S>(stream: &mut S, cancel: &mut oneshot::Receiver<()>) -> StreamStep
where
    S: futures_util::Stream<Item = reqwest::Result<bytes::Bytes>> + Unpin,
{
    let raced = async {
        tokio::select! {
            biased;
            _ = &mut *cancel => StreamStep::Cancelled,
            chunk = stream.next() => match chunk {
                None => StreamStep::End,
                Some(Ok(c)) => StreamStep::Chunk(c.to_vec()),
                Some(Err(e)) => StreamStep::Err(e.to_string()),
            },
        }
    };
    match tokio::time::timeout(std::time::Duration::from_secs(STREAM_STALL_SECS), raced).await {
        Ok(step) => step,
        Err(_) => StreamStep::Err("The model stopped responding (timed out).".to_string()),
    }
}

/// Normalized streaming event delivered to the frontend.
#[derive(Serialize, Clone)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AiEvent {
    Text { value: String },
    ToolCall { id: String, name: String, arguments: String },
    Done { finish: String },
    Error { message: String },
}

#[derive(Default, Clone)]
struct ToolAcc {
    id: String,
    name: String,
    args: String,
}

/// Accumulates streamed text deltas and forwards them to the frontend on a
/// time/size budget instead of once per token — see `TEXT_FLUSH_MS`.
struct TextBatch {
    buf: String,
    last: std::time::Instant,
}

impl TextBatch {
    fn new() -> Self {
        Self {
            buf: String::new(),
            last: std::time::Instant::now(),
        }
    }

    /// Append a delta; flush if the time or size budget is exceeded.
    fn push(&mut self, on_event: &Channel<AiEvent>, text: &str) {
        self.buf.push_str(text);
        if self.last.elapsed().as_millis() >= TEXT_FLUSH_MS
            || self.buf.len() >= TEXT_FLUSH_BYTES
        {
            self.flush(on_event);
        }
    }

    /// Send whatever is buffered (no-op if empty).
    fn flush(&mut self, on_event: &Channel<AiEvent>) {
        if !self.buf.is_empty() {
            let _ = on_event.send(AiEvent::Text {
                value: std::mem::take(&mut self.buf),
            });
            self.last = std::time::Instant::now();
        }
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ai_chat(
    state: State<'_, ChatRegistry>,
    req: ChatRequest,
    on_event: Channel<AiEvent>,
) -> Result<(), String> {
    let client = http_client()?;

    // Register a cancel channel so `cancel_chat` (Stop) can abort a hung stream.
    let (tx, rx) = oneshot::channel::<()>();
    if !req.id.is_empty() {
        state.inner.lock().unwrap().insert(req.id.clone(), tx);
    }

    let result = match req.kind.as_str() {
        "anthropic" => stream_anthropic(&client, &req, &on_event, rx).await,
        _ => stream_openai(&client, &req, &on_event, rx).await,
    };

    if !req.id.is_empty() {
        state.inner.lock().unwrap().remove(&req.id);
    }
    if let Err(e) = result {
        let _ = on_event.send(AiEvent::Error { message: e });
    }
    Ok(())
}

/// Abort an in-flight model stream. Returns true if a matching stream was live.
#[tauri::command]
pub fn cancel_chat(state: State<'_, ChatRegistry>, id: String) -> bool {
    if let Some(tx) = state.inner.lock().unwrap().remove(&id) {
        let _ = tx.send(());
        true
    } else {
        false
    }
}

// ---- OpenAI-compatible adapter --------------------------------------------

fn build_openai_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            messages.push(json!({ "role": "system", "content": sys }));
        }
    }
    for m in &req.messages {
        match m.role.as_str() {
            "tool" => messages.push(json!({
                "role": "tool",
                "tool_call_id": m.tool_call_id.clone().unwrap_or_default(),
                "content": m.content,
            })),
            "assistant" if !m.tool_calls.is_empty() => {
                let calls: Vec<Value> = m
                    .tool_calls
                    .iter()
                    .map(|c| {
                        json!({
                            "id": c.id,
                            "type": "function",
                            "function": { "name": c.name, "arguments": c.arguments },
                        })
                    })
                    .collect();
                messages.push(json!({
                    "role": "assistant",
                    "content": if m.content.is_empty() { Value::Null } else { json!(m.content) },
                    "tool_calls": calls,
                }));
            }
            role => messages.push(json!({ "role": role, "content": m.content })),
        }
    }

    let mut body = json!({
        "model": req.model,
        "messages": messages,
        "stream": true,
    });
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters,
                    },
                })
            })
            .collect();
        body["tools"] = json!(tools);
        body["tool_choice"] = json!("auto");
    }
    body
}

async fn stream_openai(
    client: &reqwest::Client,
    req: &ChatRequest,
    on_event: &Channel<AiEvent>,
    mut cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let url = format!("{}/chat/completions", req.base_url.trim_end_matches('/'));
    let mut builder = client.post(&url).json(&build_openai_body(req));
    if !req.api_key.is_empty() {
        builder = builder.bearer_auth(&req.api_key);
    }
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), txt));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tools: Vec<ToolAcc> = Vec::new();
    let mut finish = String::from("stop");
    let mut batch = TextBatch::new();

    'outer: loop {
        let chunk = match next_step(&mut stream, &mut cancel).await {
            StreamStep::Chunk(c) => c,
            StreamStep::End => break 'outer,
            StreamStep::Cancelled => {
                batch.flush(on_event);
                let _ = on_event.send(AiEvent::Done { finish: "stop".into() });
                return Ok(());
            }
            StreamStep::Err(e) => return Err(e),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            if data == "[DONE]" {
                break 'outer;
            }
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let Some(choice) = v["choices"].get(0) else {
                continue;
            };
            if let Some(text) = choice["delta"]["content"].as_str() {
                if !text.is_empty() {
                    batch.push(on_event, text);
                }
            }
            if let Some(tcs) = choice["delta"]["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                    while tools.len() <= idx {
                        tools.push(ToolAcc::default());
                    }
                    if let Some(id) = tc["id"].as_str() {
                        tools[idx].id = id.to_string();
                    }
                    if let Some(name) = tc["function"]["name"].as_str() {
                        tools[idx].name.push_str(name);
                    }
                    if let Some(args) = tc["function"]["arguments"].as_str() {
                        tools[idx].args.push_str(args);
                    }
                }
            }
            if let Some(fr) = choice["finish_reason"].as_str() {
                finish = fr.to_string();
            }
        }
    }

    batch.flush(on_event);
    emit_tools_and_done(on_event, tools, finish);
    Ok(())
}

// ---- Anthropic adapter -----------------------------------------------------

fn build_anthropic_body(req: &ChatRequest) -> Value {
    let mut messages: Vec<Value> = Vec::new();
    let mut i = 0;
    while i < req.messages.len() {
        let m = &req.messages[i];
        match m.role.as_str() {
            "system" => { /* handled top-level */ }
            "tool" => {
                // Merge a run of consecutive tool results into one user message.
                let mut blocks: Vec<Value> = Vec::new();
                while i < req.messages.len() && req.messages[i].role == "tool" {
                    let t = &req.messages[i];
                    blocks.push(json!({
                        "type": "tool_result",
                        "tool_use_id": t.tool_call_id.clone().unwrap_or_default(),
                        "content": t.content,
                    }));
                    i += 1;
                }
                messages.push(json!({ "role": "user", "content": blocks }));
                continue;
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if !m.content.is_empty() {
                    blocks.push(json!({ "type": "text", "text": m.content }));
                }
                for c in &m.tool_calls {
                    let input: Value =
                        serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({}));
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": c.id,
                        "name": c.name,
                        "input": input,
                    }));
                }
                messages.push(json!({ "role": "assistant", "content": blocks }));
            }
            _ => messages.push(json!({
                "role": "user",
                "content": [{ "type": "text", "text": m.content }],
            })),
        }
        i += 1;
    }

    let mut body = json!({
        "model": req.model,
        "max_tokens": req.max_tokens.unwrap_or(4096),
        "messages": messages,
        "stream": true,
    });
    if let Some(sys) = &req.system {
        if !sys.is_empty() {
            body["system"] = json!(sys);
        }
    }
    if let Some(t) = req.temperature {
        body["temperature"] = json!(t);
    }
    if !req.tools.is_empty() {
        let tools: Vec<Value> = req
            .tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters,
                })
            })
            .collect();
        body["tools"] = json!(tools);
    }
    body
}

async fn stream_anthropic(
    client: &reqwest::Client,
    req: &ChatRequest,
    on_event: &Channel<AiEvent>,
    mut cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    let url = format!("{}/messages", req.base_url.trim_end_matches('/'));
    let resp = client
        .post(&url)
        .header("x-api-key", &req.api_key)
        .header("anthropic-version", "2023-06-01")
        .json(&build_anthropic_body(req))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), txt));
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut tools: Vec<ToolAcc> = Vec::new();
    let mut finish = String::from("stop");
    let mut batch = TextBatch::new();

    'outer: loop {
        let chunk = match next_step(&mut stream, &mut cancel).await {
            StreamStep::Chunk(c) => c,
            StreamStep::End => break 'outer,
            StreamStep::Cancelled => {
                batch.flush(on_event);
                let _ = on_event.send(AiEvent::Done { finish: "stop".into() });
                return Ok(());
            }
            StreamStep::Err(e) => return Err(e),
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line = buf[..pos].trim().to_string();
            buf.drain(..=pos);
            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue,
            };
            let v: Value = match serde_json::from_str(data) {
                Ok(v) => v,
                Err(_) => continue,
            };
            match v["type"].as_str() {
                Some("content_block_start") => {
                    let block = &v["content_block"];
                    if block["type"] == "tool_use" {
                        tools.push(ToolAcc {
                            id: block["id"].as_str().unwrap_or_default().to_string(),
                            name: block["name"].as_str().unwrap_or_default().to_string(),
                            args: String::new(),
                        });
                    }
                }
                Some("content_block_delta") => {
                    let delta = &v["delta"];
                    match delta["type"].as_str() {
                        Some("text_delta") => {
                            if let Some(t) = delta["text"].as_str() {
                                batch.push(on_event, t);
                            }
                        }
                        Some("input_json_delta") => {
                            if let (Some(last), Some(pj)) =
                                (tools.last_mut(), delta["partial_json"].as_str())
                            {
                                last.args.push_str(pj);
                            }
                        }
                        _ => {}
                    }
                }
                Some("message_delta") => {
                    if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                        finish = sr.to_string();
                    }
                }
                Some("message_stop") => break 'outer,
                _ => {}
            }
        }
    }

    batch.flush(on_event);
    emit_tools_and_done(on_event, tools, finish);
    Ok(())
}

fn emit_tools_and_done(on_event: &Channel<AiEvent>, tools: Vec<ToolAcc>, finish: String) {
    let had_tools = tools.iter().any(|t| !t.name.is_empty());
    for t in tools {
        if t.name.is_empty() {
            continue;
        }
        let _ = on_event.send(AiEvent::ToolCall {
            id: t.id,
            name: t.name,
            arguments: if t.args.is_empty() { "{}".into() } else { t.args },
        });
    }
    let finish = if had_tools && finish == "stop" {
        "tool_calls".to_string()
    } else {
        finish
    };
    let _ = on_event.send(AiEvent::Done { finish });
}

// ---- Tools the agent uses --------------------------------------------------

#[derive(Serialize)]
pub struct CommandOutput {
    pub stdout: String,
    pub stderr: String,
    pub code: Option<i32>,
    /// True when the command was killed by Stop/timeout rather than exiting on
    /// its own. Lets the agent (and UI) distinguish "interrupted" from "failed".
    pub killed: bool,
}

/// A command the agent is currently running. Tracked so it can be listed in the
/// activity monitor and forcibly stopped even after the AI panel is closed.
struct RunningCommand {
    command: String,
    cwd: String,
    started: u64,
    /// Process-group id (== child pid, since we spawn into a fresh group). We
    /// kill the whole group so child processes (e.g. `npm` → `node`) die too.
    pgid: i32,
    /// True for long-running processes started via `run_background` (dev
    /// servers, watchers) that intentionally outlive the tool call.
    background: bool,
    /// Rolling capture of a background process's stdout+stderr (capped). `None`
    /// for ordinary one-shot commands.
    log: Option<Arc<Mutex<String>>>,
}

/// Managed state: id → running command. Shared via `Arc` so blocking worker
/// threads can register/deregister independently of the Tauri command future.
#[derive(Clone, Default)]
pub struct CommandRegistry {
    inner: Arc<Mutex<HashMap<String, RunningCommand>>>,
}

/// What the frontend activity monitor renders for each live command.
#[derive(Serialize)]
pub struct RunningInfo {
    pub id: String,
    pub command: String,
    pub cwd: String,
    pub started: u64,
    /// True for long-running background processes (dev servers, watchers).
    pub background: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Run a shell command in `cwd` and capture its output. Used by the agent's
/// `run_command` tool — this is a *separate* subprocess from the interactive
/// PTY, so it never pollutes the user's terminal.
///
/// The child is spawned into its own process group so the whole tree can be
/// killed (Stop button / timeout). A backstop timeout guards against commands
/// that never terminate (dev servers, watchers) hanging the agent forever.
#[tauri::command]
pub async fn run_command(
    state: State<'_, CommandRegistry>,
    cwd: String,
    command: String,
    id: String,
    timeout_ms: Option<u64>,
) -> Result<CommandOutput, String> {
    let reg = state.inner.clone();
    let timeout = timeout_ms.unwrap_or(300_000);

    // The child process is blocking, so run it on the blocking pool — never on
    // the main thread, or the whole UI (and the interactive PTY) freezes.
    tauri::async_runtime::spawn_blocking(move || {
        let child = shell_command(&command, &cwd)
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id() as i32;
        reg.lock().unwrap().insert(
            id.clone(),
            RunningCommand {
                command: command.clone(),
                cwd: cwd.clone(),
                started: now_ms(),
                pgid: pid,
                background: false,
                log: None,
            },
        );

        // Timeout backstop: kill the group if still registered after `timeout`.
        let reg_t = reg.clone();
        let id_t = id.clone();
        let timed_out = Arc::new(Mutex::new(false));
        let timed_out_t = timed_out.clone();
        let watcher = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(timeout));
            if reg_t.lock().unwrap().contains_key(&id_t) {
                *timed_out_t.lock().unwrap() = true;
                kill_group(pid, false);
                std::thread::sleep(Duration::from_millis(2000));
                kill_group(pid, true);
            }
        });

        // Blocks until the process group's pipes close — which happens either
        // on natural exit or when Stop/timeout kills the group.
        let out = child.wait_with_output();

        // Deregister and let the watcher fall through (it checks the registry).
        let was_present = reg.lock().unwrap().remove(&id).is_some();
        let _ = was_present;
        // Detach the watcher; if it already slept it's done, otherwise it will
        // wake, see the id gone, and exit without killing anything.
        drop(watcher);

        let killed = *timed_out.lock().unwrap();
        let out = out.map_err(|e| e.to_string())?;
        Ok(CommandOutput {
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
            code: out.status.code(),
            killed,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Forcibly stop a running agent command (and its whole process group). Returns
/// true if a matching live command was found. Sends SIGTERM, then SIGKILL after
/// a short grace period so well-behaved processes can clean up.
#[tauri::command]
pub fn cancel_command(state: State<'_, CommandRegistry>, id: String) -> bool {
    let pgid = state.inner.lock().unwrap().get(&id).map(|c| c.pgid);
    match pgid {
        Some(pgid) => {
            kill_group(pgid, false);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(2000));
                kill_group(pgid, true);
            });
            true
        }
        None => false,
    }
}

/// Kill every running agent command. Used by a global "stop all" control.
#[tauri::command]
pub fn cancel_all_commands(state: State<'_, CommandRegistry>) -> usize {
    let pgids: Vec<i32> = state
        .inner
        .lock()
        .unwrap()
        .values()
        .map(|c| c.pgid)
        .collect();
    for pgid in &pgids {
        kill_group(*pgid, false);
    }
    let pgids2 = pgids.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(2000));
        for pgid in pgids2 {
            kill_group(pgid, true);
        }
    });
    pgids.len()
}

/// Snapshot of all commands the agent is currently running. Powers the activity
/// monitor, which stays visible even when the AI panel is closed.
#[tauri::command]
pub fn list_running_commands(state: State<'_, CommandRegistry>) -> Vec<RunningInfo> {
    let map = state.inner.lock().unwrap();
    let mut v: Vec<RunningInfo> = map
        .iter()
        .map(|(id, c)| RunningInfo {
            id: id.clone(),
            command: c.command.clone(),
            cwd: c.cwd.clone(),
            started: c.started,
            background: c.background,
        })
        .collect();
    v.sort_by_key(|r| r.started);
    v
}

/// Cap on how much of a background process's output we retain (per stream we
/// keep the *tail*, so the freshest log lines survive). Keeps memory bounded
/// for chatty dev servers that run for hours.
const BG_LOG_CAP: usize = 64 * 1024;

/// Drain a child pipe (stdout or stderr) into a shared, size-capped buffer on a
/// dedicated thread. Returns when the pipe closes (i.e. the child exits). We
/// keep only the trailing `BG_LOG_CAP` bytes so the log can't grow unbounded.
fn drain_pipe<R: Read + Send + 'static>(mut pipe: R, log: Arc<Mutex<String>>) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match pipe.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buf[..n]);
                    let mut guard = log.lock().unwrap();
                    guard.push_str(&chunk);
                    if guard.len() > BG_LOG_CAP {
                        // Trim from the front on a char boundary to keep the tail.
                        let overflow = guard.len() - BG_LOG_CAP;
                        let mut cut = overflow;
                        while cut < guard.len() && !guard.is_char_boundary(cut) {
                            cut += 1;
                        }
                        *guard = guard[cut..].to_string();
                    }
                }
            }
        }
    });
}

/// Snapshot returned by `run_background` / `command_output`: the captured log so
/// far plus whether the process is still alive.
#[derive(Serialize)]
pub struct BackgroundOutput {
    pub id: String,
    pub output: String,
    pub running: bool,
}

/// Start a long-running background process (dev server, file watcher, etc.) and
/// return after a short grace period with whatever it printed so far — without
/// waiting for it to exit. The process keeps running in its own group and is
/// tracked in the registry so the activity monitor can show it and Stop can
/// kill it. Use `command_output` to poll its log later.
#[tauri::command]
pub async fn run_background(
    state: State<'_, CommandRegistry>,
    cwd: String,
    command: String,
    id: String,
    grace_ms: Option<u64>,
) -> Result<BackgroundOutput, String> {
    let reg = state.inner.clone();
    let grace = grace_ms.unwrap_or(3500);

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = shell_command(&command, &cwd)
            .spawn()
            .map_err(|e| e.to_string())?;

        let pid = child.id() as i32;
        let log = Arc::new(Mutex::new(String::new()));

        // Drain both pipes on background threads into the shared log.
        if let Some(out) = child.stdout.take() {
            drain_pipe(out, log.clone());
        }
        if let Some(err) = child.stderr.take() {
            drain_pipe(err, log.clone());
        }

        reg.lock().unwrap().insert(
            id.clone(),
            RunningCommand {
                command: command.clone(),
                cwd: cwd.clone(),
                started: now_ms(),
                pgid: pid,
                background: true,
                log: Some(log.clone()),
            },
        );

        // Reap the child on its own thread so it doesn't become a zombie, and
        // deregister it from the activity monitor once it exits on its own.
        let reg_w = reg.clone();
        let id_w = id.clone();
        std::thread::spawn(move || {
            let _ = child.wait();
            reg_w.lock().unwrap().remove(&id_w);
        });

        // Give the server a moment to boot / print its first lines, then return
        // a snapshot. We do NOT wait for exit.
        std::thread::sleep(Duration::from_millis(grace));

        let running = reg.lock().unwrap().contains_key(&id);
        let output = log.lock().unwrap().clone();
        Ok(BackgroundOutput { id, output, running })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Poll a background process's captured output (and whether it's still running).
/// Returns `running: false` with an empty log if the id isn't tracked (already
/// exited and was reaped).
#[tauri::command]
pub fn command_output(state: State<'_, CommandRegistry>, id: String) -> BackgroundOutput {
    let map = state.inner.lock().unwrap();
    match map.get(&id) {
        Some(cmd) => {
            let output = cmd
                .log
                .as_ref()
                .map(|l| l.lock().unwrap().clone())
                .unwrap_or_default();
            BackgroundOutput { id, output, running: true }
        }
        None => BackgroundOutput { id, output: String::new(), running: false },
    }
}

/// Best-effort model listing for OpenAI-compatible servers (incl. Ollama via
/// its `/v1` endpoint). Returns an empty list on failure so the UI can fall
/// back to manual entry.
#[tauri::command]
pub async fn ai_list_models(base_url: String, api_key: String) -> Result<Vec<String>, String> {
    let client = http_client()?;
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let mut builder = client.get(&url);
    if !api_key.is_empty() {
        builder = builder.bearer_auth(&api_key);
    }
    let resp = builder.send().await.map_err(|e| e.to_string())?;
    let status = resp.status();
    if !status.is_success() {
        // Surface the HTTP status so the UI can distinguish "auth failed" /
        // "wrong URL" from "reachable but empty".
        let body = resp.text().await.unwrap_or_default();
        let snippet = body.chars().take(200).collect::<String>();
        return Err(format!(
            "HTTP {}{}",
            status.as_u16(),
            if snippet.trim().is_empty() {
                String::new()
            } else {
                format!(": {snippet}")
            }
        ));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let mut ids: Vec<String> = v["data"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["id"].as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    Ok(ids)
}
