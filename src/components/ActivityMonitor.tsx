/** Global activity monitor. Two views in one popover:
 *
 *  - **Tasks** — commands *this agent* is running (polls the Rust command
 *    registry), so the user can see and stop them even with the AI panel closed.
 *  - **Ports** — every process on the machine listening on a TCP port (via
 *    `lsof`), so the user can kill stray dev servers and free ports — even ones
 *    this app never launched.
 *
 *  Both live in the backend, so this works independently of the AI panel. */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type RunningCommand,
  listRunningCommands,
  cancelCommand,
  cancelAllCommands,
} from "../lib/ai/client";
import { type PortInfo, listListeningPorts, killProcess } from "../lib/sysmon";
import { IconClose } from "../lib/icons";

/** Format an elapsed millisecond span as `12s` / `3m 04s`. */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${String(s % 60).padStart(2, "0")}s`;
}

type Tab = "tasks" | "ports";

export function ActivityMonitor() {
  const [tasks, setTasks] = useState<RunningCommand[]>([]);
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("tasks");
  const [now, setNow] = useState(() => Date.now());
  const [killing, setKilling] = useState<Set<number>>(new Set());
  const rootRef = useRef<HTMLDivElement>(null);

  // Poll the agent-command registry — cheap, in-memory, so always on.
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const list = await listRunningCommands();
        if (alive) setTasks(list);
      } catch {
        /* backend not ready / no commands */
      }
    };
    poll();
    const t = setInterval(() => {
      setNow(Date.now());
      poll();
    }, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  // Poll listening ports only while the popover is open (each poll spawns
  // `lsof`, so we don't want it running in the background forever).
  const reloadPorts = useCallback(async () => {
    try {
      setPorts(await listListeningPorts());
    } catch {
      setPorts([]);
    }
  }, []);
  useEffect(() => {
    if (!open) return;
    reloadPorts();
    const t = setInterval(reloadPorts, 3000);
    return () => clearInterval(t);
  }, [open, reloadPorts]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node))
        setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const active = tasks.length > 0;

  const toggleOpen = () => {
    setOpen((v) => {
      const next = !v;
      // Default to whichever view has something to show.
      if (next) setTab(tasks.length > 0 ? "tasks" : "ports");
      return next;
    });
  };

  const kill = async (pid: number) => {
    setKilling((s) => new Set(s).add(pid));
    try {
      await killProcess(pid);
    } catch {
      /* process may already be gone */
    }
    // Give SIGTERM a beat to take effect, then refresh.
    setTimeout(() => {
      reloadPorts();
      setKilling((s) => {
        const n = new Set(s);
        n.delete(pid);
        return n;
      });
    }, 600);
  };

  return (
    <div className="activity" ref={rootRef}>
      <button
        className={`activity-btn${active ? "" : " idle"}`}
        title={
          active
            ? `${tasks.length} agent task${tasks.length > 1 ? "s" : ""} running`
            : "Activity: tasks & ports"
        }
        onClick={toggleOpen}
      >
        <span className={`activity-dot${active ? "" : " idle"}`} />
        {active ? tasks.length : "Idle"}
      </button>
      {open && (
        <div className="activity-pop">
          <div className="activity-tabs">
            <button
              className={`activity-tab${tab === "tasks" ? " active" : ""}`}
              onClick={() => setTab("tasks")}
            >
              Tasks{tasks.length > 0 ? ` (${tasks.length})` : ""}
            </button>
            <button
              className={`activity-tab${tab === "ports" ? " active" : ""}`}
              onClick={() => setTab("ports")}
            >
              Ports{ports.length > 0 ? ` (${ports.length})` : ""}
            </button>
          </div>

          {tab === "tasks" && (
            <>
              <div className="activity-head">
                <span>Agent tasks</span>
                {active && (
                  <button
                    className="activity-stopall"
                    onClick={() => void cancelAllCommands()}
                  >
                    Stop all
                  </button>
                )}
              </div>
              {!active && (
                <div className="activity-empty">
                  No agent tasks running.
                </div>
              )}
              {tasks.map((t) => (
                <div key={t.id} className="activity-row">
                  <span className="ai-spinner" />
                  {t.background && <span className="activity-tag">server</span>}
                  <code className="activity-cmd" title={t.command}>
                    {t.command}
                  </code>
                  <span className="activity-time">
                    {fmtElapsed(now - t.started)}
                  </span>
                  <button
                    className="activity-stop icon-btn"
                    title="Stop this task"
                    onClick={() => void cancelCommand(t.id)}
                  >
                    <IconClose size={14} />
                  </button>
                </div>
              ))}
            </>
          )}

          {tab === "ports" && (
            <>
              <div className="activity-head">
                <span>Listening ports</span>
                <button className="activity-stopall" onClick={reloadPorts}>
                  Refresh
                </button>
              </div>
              {ports.length === 0 && (
                <div className="activity-empty">
                  No processes listening on a port.
                </div>
              )}
              {ports.map((p) => (
                <div key={`${p.pid}-${p.port}`} className="activity-row">
                  <span className="activity-port">:{p.port}</span>
                  <code className="activity-cmd" title={`${p.command} (pid ${p.pid}) @ ${p.address}:${p.port}`}>
                    {p.command}
                  </code>
                  <span className="activity-time">pid {p.pid}</span>
                  <button
                    className="activity-stop icon-btn"
                    title={`Kill ${p.command} (pid ${p.pid}) and free port ${p.port}`}
                    disabled={killing.has(p.pid)}
                    onClick={() => void kill(p.pid)}
                  >
                    <IconClose size={14} />
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
