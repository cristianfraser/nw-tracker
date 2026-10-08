import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import {
  afcCartolaTrueUpNoteKey,
  afcContributionNoteKey,
  applyAfcCartolaTrueUps,
  applyAfcCertImport,
  applyAfcWithdrawalUnits,
  groupAfcContributions,
  type AfcCartola,
  type AfcCotizacionesCertificate,
  planAfcCartolaTrueUps,
  planAfcCertImport,
  planAfcWithdrawalUnits,
} from "./afcCertImport.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { leafAssetGroupIdForKindSlug } from "./assetGroupTree.js";

// What ingest's parser reads from its synthetic certificate and cartola text
// (ingest/src/afc/documents.test.ts holds the text and the parser's own tests). Amounts are made up.
const CERT: AfcCotizacionesCertificate = {
  "legs": [
    {
      "period_ym": "2099-01",
      "employer_rut": "11.111.111-1",
      "employer": "EMPRESA UNO SPA",
      "renta_imponible_clp": 1000000,
      "amount_clp": 6000,
      "pay_ymd": "2099-02-10"
    },
    {
      "period_ym": "2099-01",
      "employer_rut": "11.111.111-1",
      "employer": "EMPRESA UNO SPA",
      "renta_imponible_clp": 1000000,
      "amount_clp": 16000,
      "pay_ymd": "2099-02-10"
    },
    {
      "period_ym": "2099-09",
      "employer_rut": "22.222.222-2",
      "employer": "EMPRESA DOS LIMITADA",
      "renta_imponible_clp": 2000000,
      "amount_clp": 12000,
      "pay_ymd": "2099-10-10"
    },
    {
      "period_ym": "2099-09",
      "employer_rut": "22.222.222-2",
      "employer": "EMPRESA DOS LIMITADA",
      "renta_imponible_clp": 2000000,
      "amount_clp": 32000,
      "pay_ymd": "2099-10-10"
    },
    {
      "period_ym": "2099-11",
      "employer_rut": "44.444.444-4",
      "employer": "EMPRESA CUATRO SA",
      "renta_imponible_clp": 300000,
      "amount_clp": 1000,
      "pay_ymd": "2099-12-09"
    },
    {
      "period_ym": "2099-10",
      "employer_rut": "33.333.333-3",
      "employer": "",
      "renta_imponible_clp": 500000,
      "amount_clp": 3000,
      "pay_ymd": "2099-11-12"
    }
  ],
  "total_clp": 70000
};

const CARTOLA: AfcCartola = {
  "period_from_ymd": "2099-09-01",
  "period_to_ymd": "2099-12-31",
  "saldo_inicial_ymd": "2099-08-31",
  "saldo_inicial_clp": 100000,
  "cotizaciones_clp": 48000,
  "otros_ingresos_clp": 0,
  "ganancia_clp": 0,
  "total_ingresos_clp": 48000,
  "comisiones_clp": 500,
  "otros_egresos_clp": 0,
  "uso_cuenta_clp": 60000,
  "total_egresos_clp": 60500,
  "saldo_final_ymd": "2099-12-31",
  "saldo_final_clp": 87500,
  "detalle": [
    {
      "employer": "EMPRESA DOS LIMITADA",
      "pay_month_ym": "2099-10",
      "amount_clp": 44000
    },
    {
      "employer": "EMPRESA TRES LIMITADA",
      "pay_month_ym": "2099-11",
      "amount_clp": 3000
    },
    {
      "employer": "EMPRESA CUATRO SA",
      "pay_month_ym": "2099-12",
      "amount_clp": 1000
    }
  ]
};

/** A copy with one leg's amount and the printed TOTAL raised by a peso. */
function certWithChangedLeg(): AfcCotizacionesCertificate {
  const legs = CERT.legs.map((l) => ({ ...l }));
  legs[1]!.amount_clp += 1;
  return { legs, total_clp: CERT.total_clp + 1 };
}

describe("AFC contributions", () => {
  it("collapses the two legs of a período into one contribution per pay date", () => {
    const groups = groupAfcContributions(CERT.legs);
    expect(groups.map((g) => [g.period_ym, g.pay_ymd, g.amount_clp, g.legs.length])).toEqual([
      ["2099-01", "2099-02-10", 22000, 2],
      ["2099-09", "2099-10-10", 44000, 2],
      ["2099-10", "2099-11-12", 3000, 1],
      ["2099-11", "2099-12-09", 1000, 1],
    ]);
  });
});

describe("AFC ledger rebuild (test DB)", () => {
  const PX = 4000;
  const PX_DAYS = ["2099-02-10", "2099-08-31", "2099-10-10", "2099-11-12", "2099-12-09", "2099-12-15", "2099-12-31", "2100-01-15"];
  let accountId = 0;
  let otherAccountId = 0;

  beforeAll(() => {
    const groupId = leafAssetGroupIdForKindSlug("afc");
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key, exclude_from_group_totals)
           VALUES (?, 'AFC rebuild vitest', 'vitest:afc-rebuild', ?, 0)`
        )
        .run(groupId, AFC_CIC_SERIES_KEY).lastInsertRowid
    );
    otherAccountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals)
           VALUES (?, 'AFC rebuild vitest counterpart', 'vitest:afc-rebuild-counterpart', 0)`
        )
        .run(groupId).lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO fund_unit_daily (series_key, day, unit_value_clp, note) VALUES (?, ?, ?, 'vitest:px')
       ON CONFLICT(series_key, day) DO UPDATE SET unit_value_clp = excluded.unit_value_clp, note = excluded.note`
    );
    for (const d of PX_DAYS) ins.run(AFC_CIC_SERIES_KEY, d, PX);
    // Excel-era rows: a contribution the certificate supersedes, and a non-contribution row.
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, 22000, 'clp', '2099-02-28', 'import:excel|afc-flow|vitest')`
    ).run(accountId);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, -60000, 'clp', '2099-12-15', 'import:excel|afc-flow|vitest retiro')`
    ).run(accountId);
  });

  afterAll(() => {
    for (const id of [accountId, otherAccountId]) {
      if (!id) continue;
      db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(id, id, id);
      db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM fund_unit_daily WHERE series_key = ? AND note = 'vitest:px'`).run(AFC_CIC_SERIES_KEY);
  });

  it("imports the certificate at pay-date valor cuota, replacing the excel contributions; re-runs are idempotent", () => {
    const cert = CERT;
    const plan = planAfcCertImport(accountId, cert);
    expect(plan.items.map((i) => [i.status, i.units])).toEqual([
      ["insert", 5.5],
      ["insert", 11],
      ["insert", 0.75],
      ["insert", 0.25],
    ]);
    expect(plan.excel_contribution_rows.map((m) => m.amount)).toEqual([22000]);
    expect(plan.excel_other_rows.map((m) => m.amount)).toEqual([-60000]);

    const r = applyAfcCertImport(plan, { replaceExcelContributions: true });
    expect(r).toEqual({ inserted: 4, units_updated: 0, deleted: 1, mismatches: 0 });
    const rows = db
      .prepare(`SELECT occurred_on, amount, units_delta, note FROM movements WHERE account_id = ? AND amount > 0 ORDER BY occurred_on`)
      .all(accountId) as { occurred_on: string; amount: number; units_delta: number; note: string }[];
    expect(rows.map((m) => [m.occurred_on, m.amount, m.units_delta])).toEqual([
      ["2099-02-10", 22000, 5.5],
      ["2099-10-10", 44000, 11],
      ["2099-11-12", 3000, 0.75],
      ["2099-12-09", 1000, 0.25],
    ]);
    expect(rows[0]!.note.startsWith(afcContributionNoteKey("2099-01", "2099-02-10"))).toBe(true);
    const periods = db
      .prepare(
        `SELECT m.occurred_on, p.period_month FROM pension_contribution_periods p JOIN movements m ON m.id = p.movement_id
          WHERE m.account_id = ? ORDER BY m.occurred_on`
      )
      .all(accountId)
      .map((r) => Object.values(r as object));
    expect(periods).toHaveLength(4);
    expect(periods[0]).toEqual(["2099-02-10", "2099-01"]);

    const again = planAfcCertImport(accountId, cert);
    expect(again.items.every((i) => i.status === "unchanged")).toBe(true);
    expect(again.excel_contribution_rows).toEqual([]);

    // A changed printed amount is a mismatch, never an overwrite.
    const changed = certWithChangedLeg();
    const mismatch = planAfcCertImport(accountId, changed);
    expect(mismatch.items[0]!.status).toBe("mismatch");
    expect(applyAfcCertImport(mismatch, { replaceExcelContributions: false }).mismatches).toBe(1);
  });

  it("prices withdrawals at the valor cuota of their date, then lands the cartola's saldos with true-ups", () => {
    const w = planAfcWithdrawalUnits(accountId);
    expect(w.map((x) => [x.movement.amount, x.units_abs, x.closes_position, x.status])).toEqual([[-60000, 15, false, "set"]]);
    expect(applyAfcWithdrawalUnits(w)).toBe(1);
    expect(afpCuotasCumulativeThroughDate(accountId, "2099-12-31")).toBe(2.5);

    const cartola = CARTOLA;
    const plan = planAfcCartolaTrueUps(accountId, cartola);
    expect(plan.ledger_cotizaciones_clp).toBe(48000);
    // Inicial: saldo 100.000 ÷ 4000 = 25 cuotas vs the 5,5 in the ledger → +19,5 (7x.xxx, yield-like).
    // Final: 8x.xxx ÷ 4000 = 21,875 vs 5,5 + 19,5 + 11 + 0,75 + 0,25 − 15 = 22 → −0,125 (−500 = the printed commission).
    expect(plan.trueups.map((t) => [t.which, t.units, t.amount_clp, t.flow_kind, t.status])).toEqual([
      ["inicial", 19.5, 78000, "savings_earnings", "insert"],
      ["final", -0.125, -500, "cash_fee", "insert"],
    ]);
    expect(applyAfcCartolaTrueUps(plan)).toEqual({ inserted: 2, updated: 0, deleted: 0 });
    expect(afpCuotasCumulativeThroughDate(accountId, "2099-12-31")).toBe(21.875);

    const again = planAfcCartolaTrueUps(accountId, cartola);
    expect(again.trueups.map((t) => t.status)).toEqual(["unchanged", "unchanged"]);
    const finalRow = db
      .prepare(`SELECT amount, flow_kind FROM movements WHERE account_id = ? AND note LIKE ?`)
      .get(accountId, `${afcCartolaTrueUpNoteKey("final", "2099-12-31")}%`) as { amount: number; flow_kind: string };
    expect(finalRow).toEqual({ amount: -500, flow_kind: "cash_fee" });
  });

  it("refuses a cartola whose cotizaciones are not all in the ledger", () => {
    // One more peso-thousand of cotizaciones than the ledger holds (the detalle's second row).
    const cartola: AfcCartola = {
      ...CARTOLA,
      cotizaciones_clp: 49000,
      total_ingresos_clp: 49000,
      saldo_final_clp: 88500,
      detalle: CARTOLA.detalle.map((d, i) => (i === 1 ? { ...d, amount_clp: 4000 } : d)),
    };
    expect(() => planAfcCartolaTrueUps(accountId, cartola)).toThrow(/import the certificate first/);
  });

  it("a withdrawal after which the stored valuation reads 0 closes the position with exactly the cuotas held", () => {
    db.prepare(`INSERT INTO valuations (account_id, as_of_date, value) VALUES (?, '2100-01-31', 0)`).run(accountId);
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note) VALUES (?, ?, 80000, 'clp', '2100-01-15', 'vitest retiro final')`
    ).run(accountId, otherAccountId);
    const w = planAfcWithdrawalUnits(accountId);
    const closing = w.find((x) => x.movement.occurred_on === "2100-01-15")!;
    expect(closing.closes_position).toBe(true);
    expect(closing.units_abs).toBe(21.875);
    expect(applyAfcWithdrawalUnits(w)).toBe(1);
    expect(afpCuotasCumulativeThroughDate(accountId, "2100-01-31")).toBe(0);
  });
});
