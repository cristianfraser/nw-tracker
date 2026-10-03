import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createIngestClient } from "nw-tracker-contracts";
import { registerIngestRoutes } from "./routes/ingest.js";

/** The task endpoint through the typed client a feeder uses. */
describe("POST /api/ingest/tasks/<task>", () => {
  let server: Server;
  let base = "";

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerIngestRoutes(app, { auth: { token: null, allowRemote: false, demoMode: false } });
    server = await new Promise<Server>((resolve) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const client = () => createIngestClient({ baseUrl: base, feederId: "vitest" });

  it("runs a task and answers with its verdict and report", async () => {
    const result = await client().runTask("synthetic_cc_payments_check");
    expect(result.task).toBe("synthetic_cc_payments_check");
    expect(typeof result.ok).toBe("boolean");
    expect(result.report.length).toBeGreaterThan(0);
  });

  it("a dry run of the payment-mirror conversion reports and converts nothing", async () => {
    const result = await client().runTask("cc_payment_mirrors", { dry_run: true });
    expect(result).toMatchObject({ task: "cc_payment_mirrors", ok: true });
    expect(result.report.join("\n")).not.toMatch(/Converted \d+/);
  });

  it("refuses an unknown task and a malformed request", async () => {
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const unknown = await post("/api/ingest/tasks/drop_everything", {});
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: "unknown_ingest_task" });
    const malformed = await post("/api/ingest/tasks/cc_payment_mirrors", { dry_run: "yes" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: "invalid_task_request" });
    await expect(client().runTask("cc_bank_cupo_check", { recheck: true })).resolves.toMatchObject({ task: "cc_bank_cupo_check" });
  });
});
