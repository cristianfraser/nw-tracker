import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { buildF22Draft, igcTax } from "./f22Draft.js";
import { mortgageInterestDeduction } from "./f22AppEstimates.js";
import type { UsdFxDisposalLoader } from "./usdFxTaxGains.js";

// Two synthetic years the Vitest person does not reach: fees alone (income 2018) and a salary with
// the lender's DJ 1898 (income 2019).
const NOTE = "vitest:f22-fees-mortgage";
const FEES_YEAR = 2018;
const DJ_YEAR = 2019;
const UTM = 48_000;
const UTA = UTM * 12;
const TODAY = "2026-06-01";
const noUsd: UsdFxDisposalLoader = () => ({ disposals: [], openLots: [] });
const draft = (taxYear: number) => buildF22Draft(taxYear, TODAY, { usdFx: { load: noUsd } });

describe("F22 draft: the fees box and the lender's mortgage interest", () => {
  const inserted: { table: string; key: string; value: string }[] = [];
  const insertIfMissing = (table: string, key: string, value: string, sql: string, ...args: unknown[]) => {
    if (db.prepare(sql).run(...args).changes > 0) inserted.push({ table, key, value });
  };
  const cleanup = () => {
    db.prepare(`DELETE FROM sii_issued_fee_receipts WHERE source_file = ?`).run(NOTE);
    db.prepare(`DELETE FROM sii_informed_dj WHERE source_file = ?`).run(NOTE);
  };

  beforeAll(() => {
    cleanup();
    for (const y of [FEES_YEAR, DJ_YEAR]) {
      insertIfMissing("utm_daily", "date", `${y}-12-01`, `INSERT OR IGNORE INTO utm_daily (date, utm_clp) VALUES (?, ?)`, `${y}-12-01`, UTM);
      insertIfMissing(
        "fx_daily_bcentral",
        "date",
        `${y}-12-31`,
        `INSERT OR IGNORE INTO fx_daily_bcentral (date, clp_per_usd) VALUES (?, 700)`,
        `${y}-12-31`
      );
    }
    const boleta = db.prepare(
      `INSERT INTO sii_issued_fee_receipts (number, issued_on, payer_name, gross_clp, retention_clp, retained_by, source_file)
       VALUES (?, ?, 'Vitest Payer', ?, ?, ?, ?)`
    );
    boleta.run(990_001, `${FEES_YEAR}-03-30`, 6_000_000, 600_000, "payer", NOTE);
    boleta.run(990_002, `${FEES_YEAR}-09-28`, 30_000_000, 3_000_000, "issuer", NOTE);
    const dj = db.prepare(`INSERT INTO sii_informed_dj (tax_year, dj_code, field, value, source_file) VALUES (?, ?, ?, ?, ?)`);
    dj.run(DJ_YEAR + 1, 1887, "A: Renta Total Neta Pagada (Art.42 N°1, Ley de la Renta)", "60.000.000", NOTE);
    dj.run(DJ_YEAR + 1, 1887, "B: Impuesto Unico Retenido", "4.000.000", NOTE);
    dj.run(DJ_YEAR + 1, 1898, "A: Monto Actualizado de los Intereses Pagados ($) en Dividendo", "3.000.000", NOTE);
  });

  afterAll(() => {
    cleanup();
    for (const r of inserted) db.prepare(`DELETE FROM ${r.table} WHERE ${r.key} = ?`).run(r.value);
  });

  it("drafts gross, presumed expenses capped at 15 UTA, net and the retention credit from the boletas", () => {
    const d = draft(FEES_YEAR + 1);
    expect(d.base).toBe("fees");
    const gross = 36_000_000;
    // 30 % of 36 M is 10,8 M, above 15 UTA (8,64 M): the cap applies.
    const presumed = 15 * UTA;
    expect(d.fees).toEqual({
      receipts: 2,
      grossClp: gross,
      presumedExpensesClp: presumed,
      apvClp: 0,
      netClp: gross - presumed,
      retentionClp: 3_600_000,
    });
    expect(d.draft[547]).toBe(gross);
    expect(d.draft[494]).toBe(presumed);
    expect(d.draft[110]).toBe(gross - presumed);
    expect(d.draft[198]).toBe(3_600_000);
    const tax = Math.round(igcTax(gross - presumed, UTA, FEES_YEAR + 1));
    expect(d.draft[304]).toBe(tax);
    expect(d.draft[305]).toBe(tax - 3_600_000);
  });

  it("deducts the lender's informed interest through the art. 55 bis cap, not in full", () => {
    const d = draft(DJ_YEAR + 1);
    expect(d.base).toBe("informed");
    expect(d.informed[751]).toBe(3_000_000);
    expect(d.estimatedCodes).not.toContain(750);
    // 60 M of gross income is ~104 UTA: between 90 and 150 the deduction is cut proportionally.
    const expected = mortgageInterestDeduction(3_000_000, 60_000_000, UTA);
    expect(expected).toBeLessThan(3_000_000);
    expect(d.draft[751]).toBe(3_000_000);
    expect(d.draft[750]).toBe(expected);
    expect(d.draft[170]).toBe(60_000_000 - expected);
  });
});
