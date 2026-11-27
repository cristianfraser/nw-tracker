import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  issueAlreadyReported,
  judgeCartolaXlsxResults,
  readCartolaXlsxState,
  statePendingMonths,
  withoutMonthsOnFile,
  writeCartolaXlsxState,
  type CartolaXlsxState,
} from "./cartolaXlsxState.js";

const NOT_PUBLISHED = "still not published by the bank, expected by 2026-09-10";

describe("cartola xlsx state", () => {
  it("reports a month's issue as a problem once, then as a notice while it stays the same", () => {
    const first = judgeCartolaXlsxResults(
      { months: {} },
      [{ month: "2026-08", kind: "not_published", reason: NOT_PUBLISHED, file: null }],
      "2026-09-12"
    );
    expect(first.problems).toEqual([`cartola 2026-08: ${NOT_PUBLISHED}`]);
    expect(first.notices).toEqual([]);
    expect(first.state.months["2026-08"]).toEqual({ kind: "not_published", reason: NOT_PUBLISHED, reported_on: "2026-09-12", file: null });

    const again = judgeCartolaXlsxResults(
      first.state,
      [
        { month: "2026-08", kind: "not_published", reason: NOT_PUBLISHED, file: null },
        { month: "2026-09", kind: "saved", file: "/inbox/x.xlsx", detail: "2026-09 → x.xlsx" },
      ],
      "2026-10-02"
    );
    expect(again.problems).toEqual([]);
    expect(again.notices).toEqual([`cartola 2026-08: ${NOT_PUBLISHED} — reported on 2026-09-12; later months were attempted`]);
    expect(again.state.months["2026-08"]?.reported_on).toBe("2026-09-12");
  });

  it("reports again when the reason or kind changes, and forgets a month once saved", () => {
    const state: CartolaXlsxState = {
      months: { "2026-08": { kind: "refused", reason: "cartola of account …9999", reported_on: "2026-09-12", file: "/r/a.xlsx" } },
    };
    expect(issueAlreadyReported(state, "2026-08", "refused", "cartola of account …9999")).toBe(true);
    expect(issueAlreadyReported(state, "2026-08", "refused", "no HASTA in the header")).toBe(false);
    const changed = judgeCartolaXlsxResults(
      state,
      [{ month: "2026-08", kind: "refused", reason: "no HASTA in the header", file: "/r/b.xlsx" }],
      "2026-09-13"
    );
    expect(changed.problems).toEqual(["cartola 2026-08: no HASTA in the header (kept at /r/b.xlsx, outside the inbox)"]);
    const saved = judgeCartolaXlsxResults(
      state,
      [{ month: "2026-08", kind: "saved", file: "/inbox/c.xlsx", detail: "2026-08 → c.xlsx" }],
      "2026-09-14"
    );
    expect(saved.state.months).toEqual({});
  });

  it("always reports a failure of the step itself and stores nothing for it", () => {
    const judged = judgeCartolaXlsxResults({ months: {} }, [{ month: "2026-08", kind: "failed", reason: "no call" }], "2026-09-02");
    expect(judged.problems).toEqual(["cartola 2026-08: no call"]);
    expect(judged.state.months).toEqual({});
  });

  it("drops months now on file and lists the rest oldest first", () => {
    const state: CartolaXlsxState = {
      months: {
        "2026-09": { kind: "refused", reason: "r", reported_on: "2026-10-01", file: null },
        "2026-08": { kind: "not_published", reason: "n", reported_on: "2026-09-12", file: null },
      },
    };
    expect(statePendingMonths(state)).toEqual(["2026-08", "2026-09"]);
    expect(Object.keys(withoutMonthsOnFile(state, new Set(["2026-09"])).months)).toEqual(["2026-08"]);
  });

  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it("round-trips through its file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cartola-xlsx-state-"));
    dirs.push(dir);
    const file = path.join(dir, "state.json");
    expect(readCartolaXlsxState(file)).toEqual({ months: {} });
    const state: CartolaXlsxState = { months: { "2026-08": { kind: "refused", reason: "r", reported_on: "2026-09-12", file: null } } };
    writeCartolaXlsxState(state, file);
    expect(readCartolaXlsxState(file)).toEqual(state);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });
});
