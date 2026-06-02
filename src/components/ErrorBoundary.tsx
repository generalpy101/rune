/** Isolates a subtree's render errors so a crash in one panel (e.g. the AI
 *  assistant) can't unmount the rest of the app — most importantly the
 *  terminal. Shows a minimal fallback with a reset button. */
import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  /** Shown in the fallback so the user knows which area failed. */
  label?: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary caught:", error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="error-boundary">
          <p className="error-boundary-title">
            {this.props.label ?? "This panel"} hit an error.
          </p>
          <pre className="error-boundary-msg">{this.state.error.message}</pre>
          <button className="primary" onClick={this.reset}>
            Reload panel
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
