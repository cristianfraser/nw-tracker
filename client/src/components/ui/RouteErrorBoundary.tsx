import { Component, type ErrorInfo, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import i18n from "../../i18n";

type Props = { children: ReactNode; routeKey: string };
type State = { error: Error | null };

/** A stale deploy leaves old hashed chunk URLs behind; one reload fetches the new manifest. */
function isChunkLoadError(error: Error): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|ChunkLoadError/i.test(
    `${error.name} ${error.message}`
  );
}

class RouteErrorBoundaryInner extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("RouteErrorBoundary:", error, info.componentStack);
  }

  componentDidUpdate(prev: Props) {
    // Navigating away replaces the failed page — clear the error so the new route renders.
    if (prev.routeKey !== this.props.routeKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main>
        <p className="error">{i18n.t("routeError.title")}</p>
        <p className="muted">{error.message}</p>
        <p>
          <button
            type="button"
            onClick={() =>
              isChunkLoadError(error) ? window.location.reload() : this.setState({ error: null })
            }
          >
            {i18n.t("routeError.retry")}
          </button>
        </p>
      </main>
    );
  }
}

/**
 * Route-level boundary: a page crash (or a failed lazy chunk after a stale deploy) shows an
 * inline retry instead of blanking the whole app through the top-level AppErrorBoundary —
 * sidebar, marquee, and navigation stay alive.
 */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <RouteErrorBoundaryInner routeKey={location.pathname}>{children}</RouteErrorBoundaryInner>;
}
