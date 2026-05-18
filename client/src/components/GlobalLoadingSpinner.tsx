export function GlobalLoadingSpinner() {
  return (
    <div className="global-loading-spinner" role="status" aria-live="polite" aria-label="Loading">
      <span className="global-loading-spinner__ring" />
    </div>
  );
}
