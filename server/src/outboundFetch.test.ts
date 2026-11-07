import { describe, expect, it, vi } from "vitest";
import { fetchOutboundText } from "./outboundFetch.js";

function stub(status: number, body: BodyInit) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("fetchOutboundText", () => {
  it("names the app, asks for the type, decodes Latin-1 and arms a timeout", async () => {
    const { calls, fetchImpl } = stub(200, new Blob([new Uint8Array([0x41, 0xf1, 0x6f])])); // «Año» in Latin-1
    const res = await fetchOutboundText({ label: "t", url: "https://x.test/a", userAgent: "ua/1", accept: "text/csv", decode: "latin1", fetchImpl });
    expect(res).toEqual({ status: 200, ok: true, text: "Año" });
    expect(calls[0]!.init.headers).toMatchObject({ "User-Agent": "ua/1", Accept: "text/csv" });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.init.method).toBe("GET");
  });

  it("returns a non-2xx answer for the caller to word, and tells the gate", async () => {
    const gate = { acquire: vi.fn(async () => {}), success: vi.fn(), failure: vi.fn() };
    const { fetchImpl } = stub(503, "down");
    const res = await fetchOutboundText({ label: "bcentral", url: "https://x.test", userAgent: "ua", gate, fetchImpl });
    expect(res).toMatchObject({ ok: false, status: 503, text: "down" });
    expect(gate.acquire).toHaveBeenCalledTimes(1);
    expect(gate.success).not.toHaveBeenCalled();
    expect(String(gate.failure.mock.calls[0]![0])).toMatch(/bcentral HTTP 503: down/);
    await fetchOutboundText({ label: "bcentral", url: "https://x.test", userAgent: "ua", gate, fetchImpl: stub(200, "{}").fetchImpl });
    expect(gate.success).toHaveBeenCalledTimes(1);
  });

  it("tells the gate when the request itself fails, and rethrows", async () => {
    const gate = { acquire: async () => {}, success: vi.fn(), failure: vi.fn() };
    const fetchImpl = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    await expect(fetchOutboundText({ label: "x", url: "https://x.test", userAgent: "ua", gate, fetchImpl })).rejects.toThrow("ECONNRESET");
    expect(gate.failure).toHaveBeenCalledTimes(1);
  });
});
