import { describe, expect, it } from "vitest";
import type { ApiCall } from "./capture.js";
import { countApiCalls, matchesApiCall } from "./wait.js";

const call = (endpoint: string, requestBody: unknown = null): ApiCall => ({
  endpoint,
  url: `https://api-dsk.santander.cl/perdsk/${endpoint}`,
  status: 200,
  requestBody,
  responseBody: null,
  receivedAt: "2026-01-01T00:00:00.000Z",
});

describe("matchesApiCall", () => {
  it("matches an endpoint name exactly", () => {
    expect(matchesApiCall(call("consultaUltimosMovimientos"), "consultaUltimosMovimientos")).toBe(true);
    expect(matchesApiCall(call("consultaUltimosMovimientosX"), "consultaUltimosMovimientos")).toBe(false);
  });

  it("matches a pattern over the endpoint name — both statement endpoints, never the PDF one", () => {
    const statements = /^estadoCuenta/i;
    expect(matchesApiCall(call("estadoCuentaNacional"), statements)).toBe(true);
    expect(matchesApiCall(call("estadoCuentaInternacional"), statements)).toBe(true);
    expect(matchesApiCall(call("estadoDeCuenta"), statements)).toBe(false);
  });

  it("matches a predicate over the whole call", () => {
    const clp = (c: ApiCall) => (c.requestBody as { Moneda?: string } | null)?.Moneda === "CLP";
    expect(matchesApiCall(call("x", { Moneda: "CLP" }), clp)).toBe(true);
    expect(matchesApiCall(call("x", { Moneda: "USD" }), clp)).toBe(false);
  });
});

describe("countApiCalls", () => {
  it("counts only the matching calls", () => {
    const calls = [call("estadoCuentaNacional"), call("estadoDeCuenta"), call("estadoCuentaInternacional"), call("other")];
    expect(countApiCalls(calls, /^estadoCuenta/i)).toBe(2);
    expect(countApiCalls(calls, "other")).toBe(1);
    expect(countApiCalls(calls, () => false)).toBe(0);
  });
});
