/**
 * Graceful shutdown on SIGTERM / SIGINT (`launchctl kickstart -k`, a deploy's restart, Ctrl-C):
 * stop accepting connections, stop every scheduler, let in-flight requests finish (bounded), flush
 * the usage log, checkpoint the WAL and close the database, then exit 0 (1 when a step failed;
 * each step still runs). A second signal exits at once with 1. The steps are injected so the order is testable without a server or a database.
 */

/** How long in-flight requests get to finish before their connections are cut. */
export const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

export type ShutdownDeps = {
  /** Stops accepting; resolves once every open connection has ended (`http.Server.close`). */
  closeServer: () => Promise<void>;
  /** Cuts the connections still open once the drain bound has passed. */
  closeAllConnections: () => void;
  stopSchedulers: () => void;
  /** The usage log's in-memory buffer, when the log is on. */
  flushUsageLog?: () => void;
  /** `PRAGMA wal_checkpoint(TRUNCATE)` and close. */
  checkpointAndCloseDb: () => void;
  exit: (code: number) => void;
  log: (message: string) => void;
  drainTimeoutMs?: number;
};

/** Runs the shutdown steps in order; a failing step is logged and the next ones still run. */
export async function runGracefulShutdown(deps: ShutdownDeps, signal: string): Promise<void> {
  const drainMs = deps.drainTimeoutMs ?? SHUTDOWN_DRAIN_TIMEOUT_MS;
  deps.log(`shutdown: ${signal} received; draining requests (up to ${drainMs / 1000}s)`);
  let failed = false;
  const step = (name: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      failed = true;
      deps.log(`shutdown: ${name} failed — ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  step("stopping the schedulers", deps.stopSchedulers);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const drained = await Promise.race([
    deps.closeServer().then(
      () => true,
      (e: unknown) => {
        deps.log(`shutdown: closing the server failed — ${e instanceof Error ? e.message : String(e)}`);
        return true;
      }
    ),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), drainMs);
    }),
  ]);
  clearTimeout(timer);
  if (!drained) {
    deps.log(`shutdown: requests still open after ${drainMs / 1000}s; closing their connections`);
    step("closing connections", deps.closeAllConnections);
  }
  if (deps.flushUsageLog) step("flushing the usage log", deps.flushUsageLog);
  step("closing the database", deps.checkpointAndCloseDb);
  deps.log(failed ? "shutdown: done with errors" : "shutdown: done");
  deps.exit(failed ? 1 : 0);
}

/** Installs the handlers: the first SIGTERM / SIGINT shuts down gracefully, a second exits at once. */
export function installGracefulShutdown(
  proc: Pick<NodeJS.Process, "on">,
  deps: ShutdownDeps
): void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (shuttingDown) {
      deps.log(`shutdown: second ${signal}; exiting now`);
      deps.exit(1);
      return;
    }
    shuttingDown = true;
    void runGracefulShutdown(deps, signal);
  };
  proc.on("SIGTERM", onSignal);
  proc.on("SIGINT", onSignal);
}
