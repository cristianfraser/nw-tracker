import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  computeMirrorAmount,
  mirrorSyntheticNote,
  realSyntheticNote,
} from "./checkingPre2020Synthetic.js";
import {
  loadPre2020CheckingExcelBalances,
  PRE2020_SYNTHETIC_FIRST_MONTH,
  PRE2020_SYNTHETIC_LAST_MONTH,
  resolveCfraserExcelPath,
} from "./checkingPre2020ExcelBalances.js";
import { listPre2020SourceDeposits } from "./checkingPre2020SourceDeposits.js";
import { db } from "./db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const excelPath = resolveCfraserExcelPath();

describe("checkingPre2020ExcelBalances", () => {
  it("loads cuenta corriente month-ends from Table 1-2-1", () => {
    const balances = loadPre2020CheckingExcelBalances(excelPath);
    expect(balances.get("2017-06")).toBe(400_000);
    expect(balances.get("2019-12")).toBe(214_877);
    expect(balances.size).toBeGreaterThanOrEqual(30);
  });
});

describe("computeMirrorAmount", () => {
  it("closes gap between Excel target and start + known movements", () => {
    expect(computeMirrorAmount(400_000, 0, -50_000)).toBe(450_000);
    expect(computeMirrorAmount(214_877, 1_327_088, -500_000)).toBe(-612_211);
  });
});

describe("checkingPre2020Synthetic notes", () => {
  it("uses stable note prefixes", () => {
    expect(realSyntheticNote("2018-03", "bitcoin", 42)).toBe(
      "import:checking-synthetic|real|2018-03|src:bitcoin|mov:42"
    );
    expect(mirrorSyntheticNote("2019-12", 214_877)).toBe(
      "import:checking-synthetic|mirror|2019-12|excel-target=214877"
    );
  });
});

describe("listPre2020SourceDeposits", () => {
  it("returns deposits in pre-2020 window when DB has import:excel data", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const deps = listPre2020SourceDeposits();
    for (const d of deps) {
      expect(d.occurred_on >= `${PRE2020_SYNTHETIC_FIRST_MONTH}-01`).toBe(true);
      expect(d.occurred_on <= `${PRE2020_SYNTHETIC_LAST_MONTH}-31`).toBe(true);
      expect(d.amount_clp).toBeGreaterThan(0);
    }
  });
});
