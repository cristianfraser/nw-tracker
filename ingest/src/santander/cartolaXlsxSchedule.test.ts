import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cartolaXlsxFetchEnabled,
  cartolaXlsxMonthsOnFile,
  lastClosedMonth,
  planCartolaXlsxDownloads,
  publicationDeadline,
  unpublishedIsOverdue,
} from "./cartolaXlsxSchedule.js";

const dirs: string[] = [];
function tempDir(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-xlsx-"));
  dirs.push(dir);
  for (const f of files) fs.writeFileSync(path.join(dir, f), "");
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("cartola xlsx schedule", () => {
  it("is due for the previous month from the 1st, until it is on file", () => {
    expect(lastClosedMonth("2026-12-01")).toBe("2026-11");
    expect(lastClosedMonth("2027-01-15")).toBe("2026-12");
    expect(planCartolaXlsxDownloads("2026-12-01", new Set(["2026-10"])).months).toEqual(["2026-11"]);
    const done = planCartolaXlsxDownloads("2026-12-01", new Set(["2026-10", "2026-11"]));
    expect(done.months).toEqual([]);
    expect(done.reason).toBe("the 2026-11 xlsx is on file");
  });

  it("fetches a backlog oldest first, bounded per run, from the newest month on file", () => {
    const plan = planCartolaXlsxDownloads("2026-12-03", new Set(["2025-04", "2026-07"]));
    expect(plan.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(plan.reason).toContain("1 more on later runs");
    expect(planCartolaXlsxDownloads("2026-12-03", new Set(["2026-07"]), 1).months).toEqual(["2026-08"]);
  });

  it("never chases a gap older than the newest month on file", () => {
    expect(planCartolaXlsxDownloads("2026-09-02", new Set(["2026-05", "2026-07"])).months).toEqual(["2026-08"]);
  });

  it("asks only for the last closed month when nothing is on file", () => {
    expect(planCartolaXlsxDownloads("2026-09-02", new Set()).months).toEqual(["2026-08"]);
  });

  it("waits for an unpublished month until the 10th of the next month", () => {
    expect(publicationDeadline("2026-11")).toBe("2026-12-10");
    expect(publicationDeadline("2026-12")).toBe("2027-01-10");
    expect(unpublishedIsOverdue("2026-11", "2026-12-09")).toBe(false);
    expect(unpublishedIsOverdue("2026-11", "2026-12-10")).toBe(true);
    // A backlog month is long past its deadline.
    expect(unpublishedIsOverdue("2026-08", "2026-12-01")).toBe(true);
  });

  it("reads the months on file from the filed and the inbox names", () => {
    const filed = tempDir([
      "2026-06-30 Cartola de cuenta Corriente - Junio 2026.xlsx",
      "2026-07-31 Cartola de cuenta Corriente - Julio 2026.xlsx",
      "notes.txt",
    ]);
    const inbox = tempDir(["Cartola de cuenta Corriente - Agosto 2026.xlsx", "ultimos movimientos-Cuenta Corriente.xlsx"]);
    const missing = path.join(filed, "absent");
    expect([...cartolaXlsxMonthsOnFile([filed, inbox, missing])].sort()).toEqual(["2026-06", "2026-07", "2026-08"]);
  });

  it("keeps the step off unless its gate is set", () => {
    expect(cartolaXlsxFetchEnabled({})).toBe(false);
    expect(cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "0" })).toBe(false);
    expect(cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "1" })).toBe(true);
    expect(() => cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "maybe" })).toThrow(/NW_TRACKER_CARTOLA_XLSX_FETCH/);
  });
});
