import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import {
  DEMO_WRITES_PER_VISITOR_PER_DAY,
  demoResetDue,
  demoWriteQuotaMiddleware,
  markDemoWrittenForTest,
  resetDemoDatabaseToPristine,
  resetDemoWritableStateForTest,
  saveDemoPristineCopy,
  takeDemoWrite,
} from "./demoWritable.js";
import { assertDemoManualExpenseDescription, demoWriteAllowedByPolicy } from "./demoWritePolicy.js";

afterEach(() => resetDemoWritableStateForTest());

describe("demo write policy", () => {
  it("opens the edits without free text", () => {
    expect(demoWriteAllowedByPolicy("PATCH", "/api/flows/expenses/lines/412/category")).toBe(true);
    expect(demoWriteAllowedByPolicy("PATCH", "/api/flows/expenses/lines/-7/category")).toBe(true);
    expect(demoWriteAllowedByPolicy("PUT", "/api/flows/expenses/purchase-big-group")).toBe(true);
    expect(demoWriteAllowedByPolicy("POST", "/api/income/movements/12/refund")).toBe(true);
    expect(demoWriteAllowedByPolicy("DELETE", "/api/income/movements/12/refund")).toBe(true);
    expect(demoWriteAllowedByPolicy("POST", "/api/accounts/3/cc-statement-lines/88/make-installment")).toBe(true);
    expect(demoWriteAllowedByPolicy("PUT", "/api/flows/expenses/line-pieces")).toBe(true);
    expect(demoWriteAllowedByPolicy("POST", "/api/flows/expenses/manual")).toBe(true);
    expect(demoWriteAllowedByPolicy("PATCH", "/api/flows/expenses/manual/5")).toBe(true);
    expect(demoWriteAllowedByPolicy("DELETE", "/api/flows/expenses/manual/5")).toBe(true);
  });

  it("keeps free text, creation and deletes of imported data closed", () => {
    expect(demoWriteAllowedByPolicy("PATCH", "/api/flows/expenses/purchase-notes")).toBe(false);
    expect(demoWriteAllowedByPolicy("POST", "/api/flows/expenses/big-groups")).toBe(false);
    expect(demoWriteAllowedByPolicy("DELETE", "/api/accounts/3/cc-statement-lines/88")).toBe(false);
    expect(demoWriteAllowedByPolicy("POST", "/api/movements")).toBe(false);
    expect(demoWriteAllowedByPolicy("GET", "/api/flows/expenses/manual")).toBe(false);
    expect(demoWriteAllowedByPolicy("PATCH", "/api/income/movements/12")).toBe(false);
  });

  it("checks a manual expense's description only in demo mode", () => {
    const prev = process.env.DEMO_MODE;
    try {
      delete process.env.DEMO_MODE;
      expect(() => assertDemoManualExpenseDescription("anything at all")).not.toThrow();
      process.env.DEMO_MODE = "1";
      expect(() => assertDemoManualExpenseDescription("Coffee")).not.toThrow();
      expect(() => assertDemoManualExpenseDescription(" Taxi ")).not.toThrow();
      expect(() => assertDemoManualExpenseDescription("visit my site")).toThrow(/must be one of/);
      expect(() => assertDemoManualExpenseDescription(undefined)).toThrow();
    } finally {
      if (prev === undefined) delete process.env.DEMO_MODE;
      else process.env.DEMO_MODE = prev;
    }
  });
});

describe("demo write quota", () => {
  it("allows a fixed number of writes per visitor and day", () => {
    for (let i = 0; i < DEMO_WRITES_PER_VISITOR_PER_DAY; i++) expect(takeDemoWrite("a", "2026-11-07")).toBe(true);
    expect(takeDemoWrite("a", "2026-11-07")).toBe(false);
    expect(takeDemoWrite("b", "2026-11-07")).toBe(true);
    expect(takeDemoWrite("a", "2026-11-08")).toBe(true);
  });

  function run(method: string, p: string, userAgent = "Mozilla/5.0 test") {
    const guard = demoWriteQuotaMiddleware();
    let nexted = false;
    let statusCode: number | null = null;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return { json: (payload: unknown) => void (body = payload) };
      },
    };
    const req = { method, path: p, headers: { "user-agent": userAgent, "cf-connecting-ip": "203.0.113.9" }, ip: "" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    guard(req as any, res as any, () => void (nexted = true));
    return { nexted, statusCode, body };
  }

  it("answers 429 demo_write_limit once the allowance is spent, and refuses bots", () => {
    const prevSalt = process.env.DEMO_ANALYTICS_SALT;
    process.env.DEMO_ANALYTICS_SALT = "test-salt";
    try {
      const writePath = "/api/flows/expenses/line-pieces";
      expect(run("GET", "/api/dashboard/page-bundle").nexted).toBe(true);
      expect(run("PUT", writePath, "curl/8.0").statusCode).toBe(403);
      for (let i = 0; i < DEMO_WRITES_PER_VISITOR_PER_DAY; i++) expect(run("PUT", writePath).nexted).toBe(true);
      const over = run("PUT", writePath);
      expect(over.statusCode).toBe(429);
      expect(over.body).toEqual({ error: "demo_write_limit" });
    } finally {
      if (prevSalt === undefined) delete process.env.DEMO_ANALYTICS_SALT;
      else process.env.DEMO_ANALYTICS_SALT = prevSalt;
    }
  });
});

describe("demoResetDue", () => {
  const base = { written: true, awake: true, chileYmd: "2026-11-07", chileHour: 12, nightlyDoneFor: "2026-11-07" };

  it("resets when idle after a write", () => {
    expect(demoResetDue({ ...base, awake: false }).reset).toBe(true);
    expect(demoResetDue({ ...base, awake: true }).reset).toBe(false);
  });

  it("resets at 04:00 Chile once a day, even while awake", () => {
    expect(demoResetDue({ ...base, chileYmd: "2026-11-08", chileHour: 3 })).toEqual({ reset: false, nightly: false });
    expect(demoResetDue({ ...base, chileYmd: "2026-11-08", chileHour: 4 })).toEqual({ reset: true, nightly: true });
    expect(demoResetDue({ ...base, chileYmd: "2026-11-08", chileHour: 4, nightlyDoneFor: "2026-11-08" }).reset).toBe(false);
  });

  it("skips when nothing was written (the nightly slot still counts as done)", () => {
    expect(demoResetDue({ ...base, written: false, awake: false, chileYmd: "2026-11-08", chileHour: 5 })).toEqual({
      reset: false,
      nightly: true,
    });
  });
});

describe("resetDemoDatabaseToPristine", () => {
  // A scratch database of its own: restoring the shared test DB would undo the fixtures of any
  // other suite running against it at the same time.
  it("restores the saved state, foreign keys and sequences included, and does nothing without a write", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "demo-pristine-"));
    const scratch = new Database(path.join(dir, "demo.db"));
    const pristine = path.join(dir, "demo.db.pristine");
    try {
      scratch.pragma("foreign_keys = ON");
      scratch.exec(`
        CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE);
        CREATE TABLE mark_input_changes (id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT);
        INSERT INTO parent (name) VALUES ('a'), ('b');
        INSERT INTO child (parent_id) VALUES (1), (2);
      `);
      saveDemoPristineCopy(pristine, scratch);
      const count = (t: string) => (scratch.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
      expect(resetDemoDatabaseToPristine({ pristinePath: pristine, database: scratch })).toBe(false);

      scratch.exec(`
        INSERT INTO parent (name) VALUES ('visitor');
        DELETE FROM parent WHERE id = 1;
        INSERT INTO mark_input_changes (source) VALUES ('movements');
      `);
      expect(count("child")).toBe(1);
      markDemoWrittenForTest();
      expect(resetDemoDatabaseToPristine({ pristinePath: pristine, database: scratch })).toBe(true);
      expect(scratch.prepare(`SELECT name FROM parent ORDER BY id`).pluck().all()).toEqual(["a", "b"]);
      expect(count("child")).toBe(2);
      expect(count("mark_input_changes")).toBe(0);
      expect(scratch.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'parent'`).pluck().get()).toBe(2);
      // The change log's sequence is not rewound: the next row's id is above every id this process applied.
      expect(scratch.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'mark_input_changes'`).pluck().get()).toBe(1);
      expect(scratch.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(resetDemoDatabaseToPristine({ pristinePath: pristine, database: scratch })).toBe(false);
    } finally {
      scratch.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
