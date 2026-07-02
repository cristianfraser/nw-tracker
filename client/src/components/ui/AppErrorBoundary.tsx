import { Component, type ErrorInfo, type ReactNode } from "react";
import i18n from "../../i18n";

type Props = { children: ReactNode };

type State = { error: Error | null };

/**
 * Last-resort boundary above the router: without it a single render error
 * unmounts the whole tree and leaves a blank page with no recovery path.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("AppErrorBoundary:", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert" style={{ maxWidth: 560, margin: "4rem auto", padding: "0 1rem" }}>
        <h1>{i18n.t("app.errorBoundary.title")}</h1>
        <p>{i18n.t("app.errorBoundary.body")}</p>
        <p style={{ color: "var(--text-muted, #888)", fontSize: "0.85rem" }}>
          {i18n.t("app.errorBoundary.detailLabel")}: {error.message}
        </p>
        <button type="button" onClick={() => window.location.reload()}>
          {i18n.t("app.errorBoundary.reload")}
        </button>
      </div>
    );
  }
}
