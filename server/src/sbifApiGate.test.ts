/**
 * Banco Central's rate gate (`sbifApiGate.ts`): spacing between calls, a backoff armed only by
 * quota / block answers and growing with consecutive ones, a success resetting the count, and a
 * corrupt state file set aside. The state file lives in a temporary folder
 * (`NW_TRACKER_SYNC_FILES_DIR`); the gate's knobs are set small through their env variables.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acquireSbifRequestSlot,
  isSbifApiInBackoff,
  recordSbifRequestFailure,
  recordSbifRequestSuccess,
  sbifApiBackoffRemainingMs,
} from "./sbifApiGate.js";
import { fetchBcentralJson } from "./bcentralApi.js";

const BASE_MS = 60_000;
const MAX_MS = 5 * BASE_MS;
const T0 = 1_900_000_000_000;

let dir = "";
const gateFile = () => path.join(dir, ".bcentral-api-gate.json");
const gate = () => JSON.parse(fs.readFileSync(gateFile(), "utf8"));
const quota = new Error("BCentral HTTP 503: Service Unavailable");

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nw-bcentral-gate-"));
  vi.stubEnv("NW_TRACKER_SYNC_FILES_DIR", dir);
  vi.stubEnv("BCENTRAL_BACKOFF_BASE_MS", String(BASE_MS));
  vi.stubEnv("BCENTRAL_BACKOFF_MAX_MS", String(MAX_MS));
  vi.stubEnv("BCENTRAL_MIN_REQUEST_INTERVAL_MS", "200");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sbifApiGate: backoff", () => {
  it("is open with no state file", async () => {
    expect(isSbifApiInBackoff(T0)).toBe(false);
    expect(sbifApiBackoffRemainingMs(T0)).toBe(0);
    await expect(acquireSbifRequestSlot(T0)).resolves.toBeUndefined();
  });

  it("a quota or block answer arms the backoff, which closes the gate until it ends", async () => {
    recordSbifRequestFailure(quota, T0);

    expect(isSbifApiInBackoff(T0 + BASE_MS - 1)).toBe(true);
    expect(sbifApiBackoffRemainingMs(T0 + 1_000)).toBe(BASE_MS - 1_000);
    await expect(acquireSbifRequestSlot(T0 + 1_000)).rejects.toThrow(/backoff active until .* \(59s remaining\)/);
    expect(isSbifApiInBackoff(T0 + BASE_MS)).toBe(false);
  });

  it("grows with each consecutive quota answer up to the maximum", () => {
    const lengths: number[] = [];
    for (let i = 0; i < 7; i++) {
      recordSbifRequestFailure(quota, T0);
      lengths.push(sbifApiBackoffRemainingMs(T0));
    }
    expect(lengths).toEqual([1, 2, 3, 4, 5, 5, 5].map((n) => n * BASE_MS));
    expect(gate().consecutive_failures).toBe(7);
  });

  it.each([
    ["a rate limit", "BCentral HTTP 429: Too Many Requests"],
    ["a blocked page", "Web Page Blocked"],
    ["a quota message", "Cuota de consultas excedida"],
  ])("counts %s as a quota answer", (_what, message) => {
    recordSbifRequestFailure(new Error(message), T0);
    expect(isSbifApiInBackoff(T0)).toBe(true);
  });

  it.each([
    ["a network error", "fetch failed"],
    ["an answer with no data", "BCentral HTTP 500: No hay datos para la serie"],
    ["a client error", "BCentral HTTP 400: bad request"],
  ])("does not back off on %s, but records the call", (_what, message) => {
    recordSbifRequestFailure(new Error(message), T0);
    expect(isSbifApiInBackoff(T0)).toBe(false);
    expect(gate()).toEqual({ last_request_at_ms: T0 });
  });

  it("a success resets the count, so the next quota answer starts over", () => {
    recordSbifRequestFailure(quota, T0);
    recordSbifRequestFailure(quota, T0);
    const later = T0 + 10 * BASE_MS;
    recordSbifRequestSuccess(later);
    expect(gate().consecutive_failures).toBe(0);

    recordSbifRequestFailure(quota, later);
    expect(sbifApiBackoffRemainingMs(later)).toBe(BASE_MS);
  });
});

describe("sbifApiGate: spacing", () => {
  it("waits out the minimum interval after the previous call", async () => {
    const now = Date.now();
    recordSbifRequestSuccess(now);
    const t = performance.now();
    await acquireSbifRequestSlot(now);
    expect(performance.now() - t).toBeGreaterThanOrEqual(150);
  });

  it("does not wait when the previous call is older than the interval", async () => {
    recordSbifRequestSuccess(T0);
    const t = performance.now();
    await acquireSbifRequestSlot(T0 + 1_000);
    expect(performance.now() - t).toBeLessThan(100);
  });
});

describe("sbifApiGate: the state file", () => {
  it("a corrupt file is set aside and the gate starts open", () => {
    fs.writeFileSync(gateFile(), "{ not json");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isSbifApiInBackoff(T0)).toBe(false);

    const files = fs.readdirSync(dir);
    expect(files.some((f) => f.startsWith(".bcentral-api-gate.json.corrupt-"))).toBe(true);
    expect(files).not.toContain(".bcentral-api-gate.json");
  });

  it("reads the legacy file when only it exists", () => {
    fs.writeFileSync(path.join(dir, ".sbif-api-gate.json"), JSON.stringify({ backoff_until_ms: T0 + 5_000 }));
    expect(sbifApiBackoffRemainingMs(T0)).toBe(5_000);
  });
});

describe("fetchBcentralJson through the gate", () => {
  it("a 503 arms the backoff and the next call is refused without a request", async () => {
    const fetchMock = vi.fn(async () => new Response("Service Unavailable", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const url = "https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx?function=GetSeries";

    await expect(fetchBcentralJson(url)).rejects.toThrow(/BCentral HTTP 503/);
    expect(isSbifApiInBackoff()).toBe(true);

    await expect(fetchBcentralJson(url)).rejects.toThrow(/backoff active/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a good answer leaves the gate open and records the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ Codigo: 0, Series: {} }), { status: 200 })));

    await expect(fetchBcentralJson("https://si3.bcentral.cl/SieteRestWS/SieteRestWS.ashx")).resolves.toEqual({
      Codigo: 0,
      Series: {},
    });
    expect(isSbifApiInBackoff()).toBe(false);
    expect(gate().consecutive_failures).toBe(0);
  });
});
