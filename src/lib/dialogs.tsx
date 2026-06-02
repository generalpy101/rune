import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

/**
 * Promise-based, in-app dialogs.
 *
 * Tauri's webview does NOT implement `window.prompt()` (it always returns
 * null), and native alert/confirm are inconsistent across platforms, so we
 * render our own modals into a portal mounted on <body>.
 */
function showModal<T>(
  render: (resolve: (value: T) => void) => React.ReactNode,
): Promise<T> {
  return new Promise<T>((resolve) => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const finish = (value: T) => {
      root.unmount();
      container.remove();
      resolve(value);
    };
    root.render(render(finish));
  });
}

export function promptDialog(
  message: string,
  defaultValue = "",
): Promise<string | null> {
  return showModal<string | null>((resolve) => (
    <PromptModal
      message={message}
      defaultValue={defaultValue}
      onSubmit={resolve}
    />
  ));
}

export function confirmDialog(message: string): Promise<boolean> {
  return showModal<boolean>((resolve) => (
    <ConfirmModal message={message} onResult={resolve} />
  ));
}

export function alertDialog(message: string): Promise<void> {
  return showModal<void>((resolve) => (
    <ConfirmModal message={message} alertOnly onResult={() => resolve()} />
  ));
}

function PromptModal({
  message,
  defaultValue,
  onSubmit,
}: {
  message: string;
  defaultValue: string;
  onSubmit: (value: string | null) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => onSubmit(value.trim() ? value : null);

  return (
    <div className="modal-overlay" onMouseDown={() => onSubmit(null)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-msg">{message}</div>
        <input
          ref={inputRef}
          className="modal-input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            else if (e.key === "Escape") onSubmit(null);
          }}
        />
        <div className="modal-actions">
          <button onClick={() => onSubmit(null)}>Cancel</button>
          <button className="primary" onClick={submit}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}

function ConfirmModal({
  message,
  onResult,
  alertOnly = false,
}: {
  message: string;
  onResult: (ok: boolean) => void;
  alertOnly?: boolean;
}) {
  return (
    <div className="modal-overlay" onMouseDown={() => onResult(false)}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-msg">{message}</div>
        <div className="modal-actions">
          {!alertOnly && (
            <button onClick={() => onResult(false)}>Cancel</button>
          )}
          <button className="primary" onClick={() => onResult(true)} autoFocus>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
