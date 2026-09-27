import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { applyFintualDividendDetails, planFintualDividendDetails } from "./fintualAccionesImport.js";
import { getMovementDividendDetail } from "./movementDividendDetails.js";

/**
 * Pairing a printed dividend with its ledger row: the ledger dates a reinvested dividend on
 * the DRIP day (up to five days after the broker's payment date) at the NET amount, so the
 * match is instrument + net + ±5 days, and anything the ledger lacks or holds twice is a
 * conflict rather than a guess.
 */
describe("fintualAccionesImport pairing", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function twoAccounts(): { holder: number; cash: number } {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[];
    if (rows.length < 2) throw new Error("need two accounts in the test DB");
    return { holder: rows[0]!.id, cash: rows[1]!.id };
  }

  function seed(holder: number, cash: number, amount: number, day: string): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
           VALUES (?, ?, ?, 'usd', ?, 'vitest-fintual-acciones', 'dividend_payout')`
        )
        .run(holder, cash, amount, day).lastInsertRowid
    );
    created.push(id);
    return id;
  }

  const printed = (over: Partial<Parameters<typeof planFintualDividendDetails>[0][number]> = {}) => ({
    date: "2026-07-31",
    symbol: "VTAAA",
    gross: 1.96,
    withholding: 0.29,
    net: 1.67,
    per_share: 1.903516,
    position_qty: 1.027327209,
    record_date: "2026-06-18",
    withholding_rate_pct: 15,
    tax_country: "CHL",
    ...over,
  });

  it("matches the DRIP-dated ledger row within five days and writes the breakdown", () => {
    const { holder, cash } = twoAccounts();
    const id = seed(holder, cash, 1.67, "2026-08-05");
    const accounts = { holderFor: () => [holder], fintualUsd: cash };

    const [plan] = planFintualDividendDetails([printed()], "fintual_cartola", "cartola_julio.pdf", accounts);
    expect(plan).toMatchObject({ movement_id: id, conflict: null, already_recorded: false });

    const outcomes = applyFintualDividendDetails([plan!]);
    expect(outcomes).toEqual([{ movement_id: id, outcome: "inserted" }]);
    expect(getMovementDividendDetail(id)).toMatchObject({
      gross_amount: 1.96,
      withholding_amount: 0.29,
      withholding_rate_pct: 15,
      withholding_jurisdiction: "US",
      tax_residency_country: "CHL",
      per_share_amount: 1.903516,
      record_date: "2026-06-18",
      pay_date: "2026-07-31",
      source: "fintual_cartola",
      source_ref: "cartola_julio.pdf",
    });

    // Second run over the same document: recognised, nothing rewritten.
    const [again] = planFintualDividendDetails([printed()], "fintual_cartola", "cartola_julio.pdf", accounts);
    expect(again!.already_recorded).toBe(true);
    expect(applyFintualDividendDetails([again!])).toEqual([{ movement_id: id, outcome: "unchanged" }]);
  });

  it("prefers the same-day row, and reports a missing or ambiguous ledger row as a conflict", () => {
    const { holder, cash } = twoAccounts();
    const accounts = { holderFor: () => [holder], fintualUsd: cash };

    const [missing] = planFintualDividendDetails([printed()], "fintual_certificado", "certificado.pdf", accounts);
    expect(missing!.conflict).toMatch(/no dividend_payout of VTAAA/);

    seed(holder, cash, 1.67, "2026-08-04");
    const exact = seed(holder, cash, 1.67, "2026-07-31");
    const [sameDay] = planFintualDividendDetails([printed()], "fintual_certificado", "certificado.pdf", accounts);
    expect(sameDay).toMatchObject({ movement_id: exact, conflict: null });

    seed(holder, cash, 1.67, "2026-07-31");
    const [ambiguous] = planFintualDividendDetails([printed()], "fintual_certificado", "certificado.pdf", accounts);
    expect(ambiguous!.conflict).toMatch(/several ledger dividends/);
  });

  it("flags a ledger row whose net disagrees with the document instead of matching by date", () => {
    const { holder, cash } = twoAccounts();
    const accounts = { holderFor: () => [holder], fintualUsd: cash };
    // Booked gross (1,96) where the document says the account received 1,67.
    seed(holder, cash, 1.96, "2026-07-31");
    const [plan] = planFintualDividendDetails([printed()], "fintual_cartola", "cartola_julio.pdf", accounts);
    expect(plan!.conflict).toMatch(/read 1\.96 .* but the document prints net 1\.67/);
  });

  it("refuses a ticker held nowhere or in several accounts", () => {
    const { holder, cash } = twoAccounts();
    const [none] = planFintualDividendDetails([printed()], "fintual_cartola", "x.pdf", { holderFor: () => [], fintualUsd: cash });
    expect(none!.conflict).toMatch(/no account holds VTAAA/);
    const [many] = planFintualDividendDetails([printed()], "fintual_cartola", "x.pdf", {
      holderFor: () => [holder, cash],
      fintualUsd: cash,
    });
    expect(many!.conflict).toMatch(/several accounts hold VTAAA/);
  });
});
