import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { z } from "zod";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeHandler } from "../inputError.js";
import { parseBody } from "./shared.js";
import { registerFlowsRoutes } from "./flows.js";

/**
 * Write routes read their bodies through `parseBody` (contracts `requests/` schemas): a malformed
 * body is a 400 naming the field, answered before the route touches the database; anything else a
 * route throws still reaches the 500 middleware.
 */
let server: Server;
let base = "";

const probeSchema = z.object({ id: z.number().int().positive(), label: z.string().trim().min(1, "label required") });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.post(
    "/probe",
    writeHandler((req, res) => {
      res.json(parseBody(probeSchema, req));
    })
  );
  registerFlowsRoutes(app);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : String(err), terminal: true });
  });
  server = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; json: { error?: string; terminal?: boolean } }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as { error?: string; terminal?: boolean }) : {} };
}

describe("parseBody", () => {
  it("hands the route the parsed body", async () => {
    expect(await call("POST", "/probe", { id: 2, label: " x ", other: true })).toEqual({ status: 200, json: { id: 2, label: "x" } });
  });

  it("a malformed or absent body is a 400 naming the field, never the 500 middleware", async () => {
    expect(await call("POST", "/probe", { id: "2", label: "x" })).toMatchObject({ status: 400, json: { error: expect.stringMatching(/^id: /) } });
    expect(await call("POST", "/probe", { id: 2, label: " " })).toEqual({ status: 400, json: { error: "label required" } });
    expect(await call("POST", "/probe", { id: 2 })).toEqual({ status: 400, json: { error: "label is required" } });
    expect(await call("POST", "/probe")).toEqual({ status: 400, json: { error: "id is required" } });
  });
});

describe("flows routes", () => {
  it("a body without its required fields is a 400", async () => {
    expect(await call("POST", "/api/flows/expenses/big-groups", { label: "  " })).toEqual({ status: 400, json: { error: "label required" } });
    expect(await call("PATCH", "/api/income/movements/1", {})).toEqual({
      status: 400,
      json: { error: "income_kind, excluded, force_include, or note required" },
    });
    expect(await call("POST", "/api/flows/expenses/manual", { amount: 1000, currency: "clp" })).toEqual({
      status: 400,
      json: { error: "spent_on is required" },
    });
  });

  it("a field of the wrong shape is a 400, where it used to reach the 500 middleware", async () => {
    expect(await call("PUT", "/api/flows/expenses/line-pieces", { source: "bank", line_id: 1, pieces: [] })).toEqual({
      status: 400,
      json: { error: "source must be cc or checking" },
    });
    expect(await call("PATCH", "/api/flows/expenses/real-estate/places/x/dfl2", { dfl2: true, dfl2_built_m2: "60" })).toEqual({
      status: 400,
      json: { error: "dfl2_built_m2 must be a number" },
    });
    const rule = await call("PATCH", "/api/flows/expenses/lines/1/category", { unique: true, rule_link: { kind: "store", key: "x" } });
    expect(rule.status).toBe(400);
    expect(rule.json.error).toMatch(/^rule_link\.kind: /);
  });
});
