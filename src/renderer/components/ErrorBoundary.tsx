import { Component, type ReactNode } from "react";
import { log } from "../../logging";

/**
 * Crash containment for the render tree: one broken row must cost a red card,
 * not a blank window (the M2 null-content crash blanked the whole app before
 * the type was made honest).
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  override componentDidCatch(error: Error): void {
    log.error("ui", `render crash contained: ${error.message}`);
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return (
        <div className="error-boundary">
          UI crashed: {this.state.error.message} — details in the log (diag panel).
        </div>
      );
    }
    return this.props.children;
  }
}
