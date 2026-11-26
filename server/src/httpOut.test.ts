import { describe, expect, it, vi } from "vitest";
import { OutboundTimeoutError, fetchOut } from "./httpOut.js";

/** A `fetch` that never answers: it settles only when its signal aborts, with the signal's reason. */
function hangingFetch() {
  const seen: (AbortSignal | undefined)[] = [];
  const impl = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal ?? undefined;
    seen.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  vi.stubGlobal("fetch", impl);
  return { seen };
}

describe("fetchOut", () => {
  it("bounds a call with no signal of its own and names the label and host when it times out", async () => {
    const { seen } = hangingFetch();
    const p = fetchOut("coingecko:bitcoin", "https://api.example.test/v3/coins?key=secret", {}, { timeoutMs: 30 });
    await expect(p).rejects.toBeInstanceOf(OutboundTimeoutError);
    await expect(p).rejects.toThrow("coingecko:bitcoin: no answer from api.example.test within 0.03s");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("keeps the caller's abort reason when the caller's signal fires first", async () => {
    hangingFetch();
    const caller = new AbortController();
    const p = fetchOut("fintual:goals", "https://fintual.example.test/api", { signal: caller.signal }, { timeoutMs: 5_000 });
    caller.abort(new Error("cancelled by the job"));
    await expect(p).rejects.toThrow("cancelled by the job");
    await expect(p).rejects.not.toBeInstanceOf(OutboundTimeoutError);
  });

  it("still times out when the caller passed a signal that never fires", async () => {
    hangingFetch();
    const caller = new AbortController();
    const p = fetchOut("fintual:goals", "https://fintual.example.test/api", { signal: caller.signal }, { timeoutMs: 30 });
    await expect(p).rejects.toBeInstanceOf(OutboundTimeoutError);
  });
});
