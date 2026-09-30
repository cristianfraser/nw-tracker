import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  assertStoredIpcMatchesFetch,
  nextIpcMonth,
  verifyIpcIndexAgainstVariation,
} from "./ipcSeries.js";
import { writeVerifiedIpcRows } from "./sbifSyncDb.js";
import { snapshotTables } from "./test/snapshotTables.js";

const restoreTables = snapshotTables(["ipc_daily"]);
afterAll(() => restoreTables());

// Index levels as the Banco Central prints them (8 significant decimals) and the variation it
// publishes beside them, full precision — real 2026 values of the base-2023 series.
const INDEX = [
  { date: "2026-05-01", value: 112.3686558 },
  { date: "2026-06-01", value: 112.3453996 },
  { date: "2026-07-01", value: 112.4476618 },
];
const VARIATION = [
  { date: "2026-06-01", value: -0.0206963408384979 },
  { date: "2026-07-01", value: 0.0910248219901462 },
];

describe("verifyIpcIndexAgainstVariation", () => {
  it("returns every index month when each variation matches the index", () => {
    expect(verifyIpcIndexAgainstVariation(INDEX, VARIATION)).toEqual([
      { date: "2026-05-01", ipcIndex: 112.3686558 },
      { date: "2026-06-01", ipcIndex: 112.3453996 },
      { date: "2026-07-01", ipcIndex: 112.4476618 },
    ]);
  });

  it("throws when a published variation disagrees with the index", () => {
    const off = [VARIATION[0]!, { date: "2026-07-01", value: 0.1 }];
    expect(() => verifyIpcIndexAgainstVariation(INDEX, off)).toThrow(/IPC 2026-07-01/);
  });

  it("throws on a month missing from either series", () => {
    expect(() => verifyIpcIndexAgainstVariation(INDEX, VARIATION.slice(0, 1))).toThrow(/2 index month/);
    expect(() => verifyIpcIndexAgainstVariation([INDEX[0]!, INDEX[2]!], VARIATION.slice(1))).toThrow(
      /expected 2026-06-01/
    );
  });

  it("accepts the anchor month alone (nothing published after it yet)", () => {
    expect(verifyIpcIndexAgainstVariation(INDEX.slice(0, 1), [])).toEqual([
      { date: "2026-05-01", ipcIndex: 112.3686558 },
    ]);
  });

  it("rolls the month over the year end", () => {
    expect(nextIpcMonth("2025-12-01")).toBe("2026-01-01");
  });
});

describe("assertStoredIpcMatchesFetch", () => {
  const fetched = verifyIpcIndexAgainstVariation(INDEX, VARIATION);

  it("passes when overlapping months agree", () => {
    expect(() => assertStoredIpcMatchesFetch(new Map([["2026-05-01", 112.3686558]]), fetched)).not.toThrow();
  });

  it("throws on a stored month from another base or a corrupt parse", () => {
    // The pre-fix rows: «133.823492253» read with the dot as a thousands separator.
    expect(() => assertStoredIpcMatchesFetch(new Map([["2026-05-01", 1123686558]]), fetched)).toThrow(
      /--replace-ipc/
    );
  });
});

describe("writeVerifiedIpcRows", () => {
  const rows = verifyIpcIndexAgainstVariation(INDEX, VARIATION);
  const stored = () =>
    db.prepare(`SELECT date, ipc_index FROM ipc_daily WHERE date >= '2026-05-01' ORDER BY date`).all();

  beforeEach(() => {
    db.prepare(`DELETE FROM ipc_daily`).run();
  });

  it("appends months after the stored anchor and counts only the new ones", () => {
    db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`).run("2026-05-01", 112.3686558);
    expect(writeVerifiedIpcRows(rows, { replace: false, dryRun: false })).toBe(2);
    expect(stored()).toHaveLength(3);
  });

  it("refuses to splice onto a stored month that differs, and writes nothing", () => {
    db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`).run("2026-05-01", 133.8);
    expect(() => writeVerifiedIpcRows(rows, { replace: false, dryRun: false })).toThrow(/rebased/);
    expect(stored()).toEqual([{ date: "2026-05-01", ipc_index: 133.8 }]);
  });

  it("replace reloads the table whole; dry run writes nothing", () => {
    db.prepare(`INSERT INTO ipc_daily (date, ipc_index) VALUES (?, ?)`).run("2023-12-01", 134097863585);
    expect(writeVerifiedIpcRows(rows, { replace: true, dryRun: true })).toBe(3);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ipc_daily`).get()).toEqual({ n: 1 });
    expect(writeVerifiedIpcRows(rows, { replace: true, dryRun: false })).toBe(3);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM ipc_daily`).get()).toEqual({ n: 3 });
  });
});
