import { execFileSync } from "node:child_process";
import { log } from "./log.js";

/** How long the bank's hosts may stay unreachable before the run gives up on the network. */
const NETWORK_WAIT_DEADLINE_MS = 90_000;
/** Pause between reachability probes while a host is still unreachable. */
const NETWORK_WAIT_POLL_MS = 3_000;
/** Per-probe budget — a probe that hangs on DNS or TLS counts as unreachable, not as pending. */
const NETWORK_PROBE_TIMEOUT_MS = 8_000;
/** A wake younger than this is named in the log next to a network wait: it is the likely reason. */
const RECENT_WAKE_MAX_AGE_MS = 5 * 60_000;

export type WaitForHostsOptions = {
  deadlineMs?: number;
  pollMs?: number;
};

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
}

/** Node's `fetch` wraps the socket error as «fetch failed» with the real one in `cause`. */
function fetchFailureReason(err: unknown): string {
  const cause = err instanceof Error && "cause" in err ? (err as { cause?: unknown }).cause : undefined;
  return cause !== undefined ? firstLine(cause) : firstLine(err);
}

/**
 * Seconds since the machine last woke from sleep (macOS `kern.waketime`), or null when the sysctl
 * is unavailable. Read for the log only — it explains a wait, it never decides one.
 */
export function secondsSinceWake(now = Date.now()): number | null {
  try {
    const out = execFileSync("sysctl", ["-n", "kern.waketime"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const sec = /sec\s*=\s*(\d+)/.exec(out)?.[1];
    if (!sec) return null;
    return Math.max(0, Math.round(now / 1000 - Number(sec)));
  } catch {
    return null;
  }
}

function recentWakeNote(): string {
  const age = secondsSinceWake();
  return age !== null && age * 1000 < RECENT_WAKE_MAX_AGE_MS ? ` (the machine woke from sleep ${age}s ago)` : "";
}

/**
 * Why `https://<host>/` did not answer, or null when it did. Any HTTP status counts as an answer —
 * a 5xx is the bank's problem, not the network's — so only DNS, connect, TLS and timeout failures
 * report a reason.
 */
async function probeHost(host: string): Promise<string | null> {
  try {
    await fetch(`https://${host}/`, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(NETWORK_PROBE_TIMEOUT_MS),
    });
    return null;
  } catch (err) {
    return fetchFailureReason(err);
  }
}

/**
 * Block until every host answers, or throw once the deadline passes.
 *
 * launchd runs a scheduled job the machine slept through as soon as it wakes, so the nightly run can
 * start seconds after a wake from hibernation — on 2026-09-25 Chrome was up 40 s after the wake
 * (battery at 1%), the public homepage loaded five times slower than usual, and the login panel
 * rendered the bank's «Comprueba tu conexión a internet» card in place of the login iframe, whose
 * document comes from the private-app host. Waiting here, before anything is opened, turns that into
 * a logged pause; a network that never comes back fails the run with the socket error instead of a
 * selector timeout over a half-loaded page. The wait is unconditional: when the network is up both
 * probes answer in well under a second.
 */
export async function waitForHosts(hosts: readonly string[], opts: WaitForHostsOptions = {}): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? NETWORK_WAIT_DEADLINE_MS;
  const pollMs = opts.pollMs ?? NETWORK_WAIT_POLL_MS;
  const started = Date.now();
  let announced = false;
  for (;;) {
    const results = await Promise.all(hosts.map(async (host) => ({ host, reason: await probeHost(host) })));
    const unreachable = results.filter((r): r is { host: string; reason: string } => r.reason !== null);
    if (unreachable.length === 0) {
      if (announced) log(`network is up after ${Math.round((Date.now() - started) / 1000)}s`);
      return;
    }
    const detail = unreachable.map((r) => `${r.host}: ${r.reason}`).join("; ");
    const waitedMs = Date.now() - started;
    if (waitedMs >= deadlineMs) {
      throw new Error(`Network unreachable after ${Math.round(waitedMs / 1000)}s — ${detail}${recentWakeNote()}`);
    }
    if (!announced) {
      announced = true;
      log(`waiting for the network — ${detail}${recentWakeNote()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
