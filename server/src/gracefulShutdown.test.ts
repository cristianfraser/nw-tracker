import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGracefulShutdown, runGracefulShutdown, type ShutdownDeps } from "./gracefulShutdown.js";

function fakeDeps(over: Partial<ShutdownDeps> = {}) {
  const steps: string[] = [];
  let releaseServer: () => void = () => {};
  const deps: ShutdownDeps = {
    closeServer: () =>
      new Promise<void>((resolve) => {
        steps.push("closeServer");
        releaseServer = () => {
          steps.push("drained");
          resolve();
        };
      }),
    closeAllConnections: () => steps.push("closeAllConnections"),
    stopSchedulers: () => steps.push("stopSchedulers"),
    flushUsageLog: () => steps.push("flushUsageLog"),
    checkpointAndCloseDb: () => steps.push("checkpointAndCloseDb"),
    exit: (code) => steps.push(`exit:${code}`),
    log: () => {},
    drainTimeoutMs: 10_000,
    ...over,
  };
  return { deps, steps, release: () => releaseServer() };
}

describe("runGracefulShutdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the schedulers, waits for the requests, flushes, closes the database, exits 0", async () => {
    const { deps, steps, release } = fakeDeps();
    const done = runGracefulShutdown(deps, "SIGTERM");
    await vi.advanceTimersByTimeAsync(3_000);
    expect(steps).toEqual(["stopSchedulers", "closeServer"]);
    release();
    await done;
    expect(steps).toEqual(["stopSchedulers", "closeServer", "drained", "flushUsageLog", "checkpointAndCloseDb", "exit:0"]);
  });

  it("cuts the connections still open after the drain bound", async () => {
    const { deps, steps } = fakeDeps();
    const done = runGracefulShutdown(deps, "SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);
    await done;
    expect(steps).toEqual(["stopSchedulers", "closeServer", "closeAllConnections", "flushUsageLog", "checkpointAndCloseDb", "exit:0"]);
  });

  it("still closes the database when a step throws, and exits 1", async () => {
    const { deps, steps, release } = fakeDeps({
      flushUsageLog: () => {
        throw new Error("disk full");
      },
    });
    const done = runGracefulShutdown(deps, "SIGINT");
    release();
    await done;
    expect(steps.slice(-2)).toEqual(["checkpointAndCloseDb", "exit:1"]);
  });
});

describe("installGracefulShutdown", () => {
  // The first signal's drain timer stays pending; fake timers keep it out of the fork's process.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("shuts down on the first signal and exits at once on the second", () => {
    const handlers = new Map<string, (s: NodeJS.Signals) => void>();
    const proc = { on: (event: string, fn: (s: NodeJS.Signals) => void) => handlers.set(event, fn) };
    const { deps, steps } = fakeDeps();
    installGracefulShutdown(proc as unknown as Pick<NodeJS.Process, "on">, deps);
    expect([...handlers.keys()].sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")!("SIGTERM");
    expect(steps).toEqual(["stopSchedulers", "closeServer"]);
    handlers.get("SIGINT")!("SIGINT");
    expect(steps).toEqual(["stopSchedulers", "closeServer", "exit:1"]);
  });
});
