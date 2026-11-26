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
  it("orders stamped rows by batch, moment and write order, then the unstamped ones by day", () => {
    const keys: LatestRowOrderKey[] = [
      { stamped: false, on: "2026-01-14" },
      { stamped: true, batchAtMs: 100, happenedMs: 5, seq: 1 },
      { stamped: false, on: "2026-01-15" },
      { stamped: true, batchAtMs: 200, happenedMs: 1, seq: 2 },
      { stamped: true, batchAtMs: 100, happenedMs: 5, seq: 3 },
      { stamped: true, batchAtMs: 100, happenedMs: 9, seq: 0 },
    ];
    expect([...keys].sort(compareLatestRowOrderKeys)).toEqual([
      { stamped: true, batchAtMs: 200, happenedMs: 1, seq: 2 },
      { stamped: true, batchAtMs: 100, happenedMs: 9, seq: 0 },
      { stamped: true, batchAtMs: 100, happenedMs: 5, seq: 3 },
      { stamped: true, batchAtMs: 100, happenedMs: 5, seq: 1 },
      { stamped: false, on: "2026-01-15" },
      { stamped: false, on: "2026-01-14" },
    ]);
  });
});
