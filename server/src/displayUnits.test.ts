/** The display-unit request param, the refusal of an unsupported unit, `/api/currencies`. */
import express from "express";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CurrenciesResponse } from "nw-tracker-contracts/dto";
import {
  DisplayUnitNotSupportedError,
  DisplayUnitRequestError,
  parseDisplayUnit,
  requestDisplayUnit,
} from "./displayUnits.js";
import { registerMetaRoutes } from "./routes/meta.js";

describe("requestDisplayUnit", () => {
  const surface = "test surface";

  it("reads ?unit=, case-insensitively, defaulting to CLP", () => {
    expect(requestDisplayUnit({}, { surface })).toBe("clp");
    expect(requestDisplayUnit({ unit: "USD" }, { surface })).toBe("usd");
    expect(requestDisplayUnit({ unit: "eur" }, { surface })).toBe("eur");
  });

  it("ignores the retired include_usd / include_uf flags", () => {
    expect(requestDisplayUnit({ include_usd: "1" }, { surface })).toBe("clp");
    expect(requestDisplayUnit({ include_uf: "1" }, { surface, allowUf: true })).toBe("clp");
  });

  it("refuses an unknown code and uf where the surface does not take it", () => {
    expect(() => requestDisplayUnit({ unit: "xyz" }, { surface })).toThrow(DisplayUnitRequestError);
    expect(() => parseDisplayUnit("uf", "clp")).toThrow(DisplayUnitRequestError);
    expect(parseDisplayUnit("uf", "clp", { allowUf: true })).toBe("uf");
  });

  it("refuses a unit the surface does not support yet, naming the surface", () => {
    expect(() => requestDisplayUnit({ unit: "eur" }, { surface, supported: ["clp", "usd"] })).toThrow(
      DisplayUnitNotSupportedError
    );
    expect(() => requestDisplayUnit({ unit: "eur" }, { surface, supported: ["clp", "usd"] })).toThrow(
      /test surface does not support display unit eur/
    );
    expect(requestDisplayUnit({ unit: "uf" }, { surface, allowUf: true, supported: ["clp", "usd", "uf"] })).toBe(
      "uf"
    );
  });
});

describe("GET /api/currencies", () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const app = express();
    registerMetaRoutes(app);
    await new Promise<void>((resolve) => {
      server = app.listen(0, "127.0.0.1", () => resolve());
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  });

  it("lists the loaded currencies, core first, with symbol and minor digits", async () => {
    const res = await fetch(`${baseUrl}/api/currencies`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as CurrenciesResponse;
    const byCode = new Map(body.currencies.map((c) => [c.code, c]));
    expect(byCode.get("clp")).toEqual({ code: "clp", symbol: "$", minor_digits: 0, tier: "core" });
    expect(byCode.get("usd")).toEqual({ code: "usd", symbol: "US$", minor_digits: 2, tier: "core" });
    expect(byCode.get("eur")).toMatchObject({ code: "eur", minor_digits: 2, tier: "core" });
    const firstNonCore = body.currencies.findIndex((c) => c.tier !== "core");
    if (firstNonCore >= 0) expect(body.currencies.slice(firstNonCore).every((c) => c.tier !== "core")).toBe(true);
  });
});
