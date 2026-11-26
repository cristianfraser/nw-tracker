import { describe, expect, it } from "vitest";
import { arrivalBatchOf, compareLatestRowOrderKeys, happenedEstimateMs, type LatestRowOrderKey } from "./latestMovementOrder.js";

const at = (hhmm: string) => Date.parse(`2026-01-15T${hhmm}:00-03:00`);
const runs = [
  { startedMs: at("19:30"), endMs: at("19:40") },
  { startedMs: at("20:30"), endMs: at("20:41") },
];

describe("arrivalBatchOf", () => {
  it("puts a write inside a run in that run's batch, dated at its start, with the previous run's start", () => {
    expect(arrivalBatchOf(at("20:35"), runs)).toEqual({ atMs: at("20:30"), prevRunStartMs: at("19:30") });
    expect(arrivalBatchOf(at("19:30"), runs)).toEqual({ atMs: at("19:30"), prevRunStartMs: null });
  });

  it("makes any other write a batch of its own", () => {
    expect(arrivalBatchOf(at("21:00"), runs)).toEqual({ atMs: at("21:00"), prevRunStartMs: null });
    expect(arrivalBatchOf(at("10:00"), runs)).toEqual({ atMs: at("10:00"), prevRunStartMs: null });
  });
});

describe("happenedEstimateMs", () => {
  const stamp = { atMs: at("20:35"), seq: 1 };
  const batch = { atMs: at("20:30"), prevRunStartMs: at("19:30") };
  it("takes a stated time first, else the earliest bound", () => {
    expect(happenedEstimateMs({ stated: [at("09:15"), at("11:00")], bounds: [at("20:10")] }, stamp, batch)).toBe(at("09:15"));
    expect(happenedEstimateMs({ stated: [], bounds: [at("20:20"), at("20:10")] }, stamp, batch)).toBe(at("20:10"));
  });

  it("else the middle of the window since the previous run started, else the write", () => {
    expect(happenedEstimateMs({ stated: [], bounds: [] }, stamp, batch)).toBe(Math.round((at("19:30") + at("20:35")) / 2));
    expect(happenedEstimateMs({ stated: [], bounds: [] }, stamp, { atMs: at("20:35"), prevRunStartMs: null })).toBe(at("20:35"));
  });
});

describe("compareLatestRowOrderKeys", () => {
  it("orders stamped rows by batch, day, moment and write order, then the unstamped ones by day", () => {
    const keys: LatestRowOrderKey[] = [
      { stamped: false, on: "2026-01-14" },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 5, seq: 1 },
      { stamped: false, on: "2026-01-15" },
      { stamped: true, batchAtMs: 200, on: "2026-01-01", happenedMs: 1, seq: 2 },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 5, seq: 3 },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 9, seq: 0 },
    ];
    expect([...keys].sort(compareLatestRowOrderKeys)).toEqual([
      { stamped: true, batchAtMs: 200, on: "2026-01-01", happenedMs: 1, seq: 2 },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 9, seq: 0 },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 5, seq: 3 },
      { stamped: true, batchAtMs: 100, on: "2026-01-10", happenedMs: 5, seq: 1 },
      { stamped: false, on: "2026-01-15" },
      { stamped: false, on: "2026-01-14" },
    ]);
  });

  it("inside a batch, puts a later day first whatever the moment or write order (a statement not printed by date)", () => {
    const row = (on: string, seq: number): LatestRowOrderKey => ({ stamped: true, batchAtMs: 100, on, happenedMs: 50, seq });
    const printed = [row("2026-11-02", 1), row("2026-11-02", 2), row("2026-11-04", 3), row("2026-11-07", 4), row("2026-11-02", 5), row("2026-11-01", 6), row("2026-11-09", 7)];
    expect([...printed].sort(compareLatestRowOrderKeys).map((k) => (k.stamped ? `${k.on}#${k.seq}` : ""))).toEqual([
      "2026-11-09#7",
      "2026-11-07#4",
      "2026-11-04#3",
      "2026-11-02#5",
      "2026-11-02#2",
      "2026-11-02#1",
      "2026-11-01#6",
    ]);
    // A later stated moment on an earlier day stays below the later day.
    const early = { stamped: true, batchAtMs: 100, on: "2026-11-01", happenedMs: 999, seq: 9 } as const;
    expect([early, row("2026-11-02", 1)].sort(compareLatestRowOrderKeys)[0]).toEqual(row("2026-11-02", 1));
  });
});
