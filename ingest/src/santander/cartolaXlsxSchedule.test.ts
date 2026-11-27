import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SYNTHETIC_ACCOUNT, syntheticCartolaXlsx } from "./testdata/cartolaXlsxFixture.js";
import {
  cartolaXlsxFetchEnabled,
  filedCartolaXlsxMonths,
  inboxCartolaXlsxMonths,
  lastClosedMonth,
  planCartolaXlsxDownloads,
  publicationDeadline,
  unpublishedIsOverdue,
} from "./cartolaXlsxSchedule.js";

const dirs: string[] = [];
function tempDir(files: string[] | Record<string, Buffer>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-xlsx-"));
  dirs.push(dir);
  const entries = Array.isArray(files) ? files.map((f) => [f, Buffer.alloc(0)] as const) : Object.entries(files);
  for (const [f, bytes] of entries) fs.writeFileSync(path.join(dir, f), bytes);
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
    expect(planCartolaXlsxDownloads("2026-12-03", new Set(["2026-07"]), [], 1).months).toEqual(["2026-08"]);
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

  it("keeps a reported month in the backlog after later months are on file", () => {
    const plan = planCartolaXlsxDownloads("2026-12-03", new Set(["2026-07", "2026-09", "2026-10", "2026-11"]), ["2026-08"]);
    expect(plan.months).toEqual(["2026-08"]);
    expect(planCartolaXlsxDownloads("2026-12-03", new Set(["2026-07", "2026-08"]), ["2026-08"]).months).toEqual([
      "2026-09",
      "2026-10",
      "2026-11",
    ]);
  });

  it("counts in the organizer's folder only the organizer's own names", () => {
    const filed = tempDir([
      "2026-06-30 Cartola de cuenta Corriente - Junio 2026.xlsx",
      "2026-07-31 Cartola de cuenta Corriente - Julio 2026.xlsx",
      // Dated names that are not the organizer's: another document, a cuenta vista cartola.
      "2026-08-31 otro documento.xlsx",
      "2026-09-30 cartola cuenta vista.xlsx",
      "notes.txt",
    ]);
    expect([...filedCartolaXlsxMonths(filed)].sort()).toEqual(["2026-06", "2026-07"]);
    expect(filedCartolaXlsxMonths(path.join(filed, "absent")).size).toBe(0);
  });

  it("counts an inbox workbook by its header, never by its name", () => {
    const inbox = tempDir({
      "Cartola de cuenta Corriente - Julio 2026.xlsx": syntheticCartolaXlsx(),
      // Named like a checking cartola, but another account's / a cuenta vista's.
      "Cartola de cuenta Corriente - Agosto 2026.xlsx": syntheticCartolaXlsx({
        account: "0-070-00-55555-5",
        desde: "31/07/2026",
        hasta: "31/08/2026",
      }),
      "2026-09-30 Cartola de cuenta Corriente - Septiembre 2026.xlsx": syntheticCartolaXlsx({
        type: "CUENTA VISTA",
        desde: "31/08/2026",
        hasta: "30/09/2026",
      }),
      // The right cartola under a name naming another month: the organizer would misfile it.
      "Cartola de cuenta Corriente - Octubre 2026.xlsx": syntheticCartolaXlsx(),
      "ultimos movimientos-Cuenta Corriente.xlsx": Buffer.from("<html>not a workbook</html>"),
    });
    expect([...inboxCartolaXlsxMonths(inbox, SYNTHETIC_ACCOUNT)]).toEqual(["2026-07"]);
  });

  it("keeps the step off unless its gate is set", () => {
    expect(cartolaXlsxFetchEnabled({})).toBe(false);
    expect(cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "0" })).toBe(false);
    expect(cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "1" })).toBe(true);
    expect(() => cartolaXlsxFetchEnabled({ NW_TRACKER_CARTOLA_XLSX_FETCH: "maybe" })).toThrow(/NW_TRACKER_CARTOLA_XLSX_FETCH/);
  });
});
