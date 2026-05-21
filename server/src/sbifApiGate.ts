/**
 * Rate-limit and backoff for Banco Central BDE / legacy SBIF HTTP (shared gate).
 * State persists across dev server reloads so stale sync does not hammer external APIs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type SbifApiGateFile = {
  /** Do not call SBIF before this epoch ms. */
  backoff_until_ms?: number;
  last_request_at_ms?: number;
  consecutive_failures?: number;
};

function gatePath(): string {
  const primary = path.join(__dirname, "..", "data", ".bcentral-api-gate.json");
  const legacy = path.join(__dirname, "..", "data", ".sbif-api-gate.json");
  if (fs.existsSync(primary)) return primary;
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

function loadGate(): SbifApiGateFile {
  const p = gatePath();
  if (!fs.existsSync(p)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    return raw as SbifApiGateFile;
  } catch {
    return {};
  }
}

function saveGate(g: SbifApiGateFile): void {
  const p = gatePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(g, null, 2) + "\n", "utf8");
}

function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const MIN_INTERVAL_MS = () =>
  envMs("BCENTRAL_MIN_REQUEST_INTERVAL_MS", envMs("SBIF_MIN_REQUEST_INTERVAL_MS", 3_000));
const BACKOFF_BASE_MS = () =>
  envMs("BCENTRAL_BACKOFF_BASE_MS", envMs("SBIF_BACKOFF_BASE_MS", 15 * 60 * 1000));
const BACKOFF_MAX_MS = () =>
  envMs("BCENTRAL_BACKOFF_MAX_MS", envMs("SBIF_BACKOFF_MAX_MS", 6 * 60 * 60 * 1000));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when BDE/SBIF calls should be skipped (quota / block backoff). */
export function isSbifApiInBackoff(nowMs = Date.now()): boolean {
  const g = loadGate();
  const until = g.backoff_until_ms ?? 0;
  return until > nowMs;
}

export function sbifApiBackoffRemainingMs(nowMs = Date.now()): number {
  const g = loadGate();
  const until = g.backoff_until_ms ?? 0;
  return Math.max(0, until - nowMs);
}

/** Wait for min spacing between SBIF HTTP calls. */
export async function acquireSbifRequestSlot(nowMs = Date.now()): Promise<void> {
  const g = loadGate();
  const until = g.backoff_until_ms ?? 0;
  if (until > nowMs) {
    throw new Error(
      `BCentral API backoff active until ${new Date(until).toISOString()} (${Math.ceil((until - nowMs) / 1000)}s remaining)`
    );
  }
  const last = g.last_request_at_ms ?? 0;
  const wait = MIN_INTERVAL_MS() - (nowMs - last);
  if (wait > 0) await sleep(wait);
}

export function isSbifQuotaOrBlockError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    msg.includes("web page blocked") ||
    msg.includes("quota") ||
    msg.includes("cuota") ||
    msg.includes("429") ||
    msg.includes("403 forbidden") ||
    (msg.includes("sbif http 5") && !msg.includes("no hay datos")) ||
    (msg.includes("bcentral http 5") && !msg.includes("no hay datos"))
  );
}

export function recordSbifRequestSuccess(nowMs = Date.now()): void {
  const g = loadGate();
  g.last_request_at_ms = nowMs;
  g.consecutive_failures = 0;
  saveGate(g);
}

export function recordSbifRequestFailure(e: unknown, nowMs = Date.now()): void {
  const g = loadGate();
  g.last_request_at_ms = nowMs;
  if (!isSbifQuotaOrBlockError(e)) {
    saveGate(g);
    return;
  }
  const fails = (g.consecutive_failures ?? 0) + 1;
  const mult = Math.min(8, fails);
  const backoff = Math.min(BACKOFF_MAX_MS(), BACKOFF_BASE_MS() * mult);
  g.consecutive_failures = fails;
  g.backoff_until_ms = nowMs + backoff;
  saveGate(g);
}
