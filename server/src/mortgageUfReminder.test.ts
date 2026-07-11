import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  buildMortgageUfReminder,
  decideMortgageUfReminder,
  type MortgageUfReminderDecisionInput,
} from "./mortgageUfReminder.js";
import { getVitestSantanderCcMasterAccountId, wipeVitestCcFixtureData } from "./test/vitestDbSeed.js";
import { insertDeptoPaymentRow } from "./deptoDividendosLedger.js";

/**
 * Cycle month 2099-06, default 21→20 config: payable window 2099-06-11 … 2099-07-10,
 * cierre 2099-06-20, first post-cierre day 2099-06-21, delayed charge → facturación 2099-07.
 */
const CYCLE = {
  cycle_month: "2099-06",
  window_start: "2099-06-11",
  window_end: "2099-07-10",
  cierre_iso: "2099-06-20",
  pay_after_iso: "2099-06-21",
  next_billing_month: "2099-07",
  card_last4: "0000",
};

/** Constant-rate UF series across the window (one publication regime): rate CLP/day. */
function ufSeries(base: number, ratePerDay: number): Map<string, number> {
  const out = new Map<string, number>();
  const start = new Date(Date.UTC(2099, 5, 11)); // 2099-06-11
  for (let i = 0; i <= 29; i++) {
    // 06-11 .. 07-10
    const d = new Date(start);
    d.setUTCDate(d.getUTCDate() + i);
    out.set(d.toISOString().slice(0, 10), base + ratePerDay * i);
  }
  return out;
}

function decisionInput(over: Partial<MortgageUfReminderDecisionInput>): MortgageUfReminderDecisionInput {
  return {
    today_ymd: "2099-06-11",
    ...CYCLE,
    paid: false,
    ufByYmd: ufSeries(40_000, 0),
    ...over,
  };
}

describe("decideMortgageUfReminder (pure matrix)", () => {
  it("rising month → not_qualified (hidden)", () => {
    const r = decideMortgageUfReminder(decisionInput({ ufByYmd: ufSeries(40_000, 10) }));
    expect(r.show).toBe(false);
    expect(r.reason).toBe("not_qualified");
  });

  it("flat month → wait, best date at window end, uf_now = uf_best", () => {
    const r = decideMortgageUfReminder(decisionInput({ ufByYmd: ufSeries(40_000, 0) }));
    expect(r.show).toBe(true);
    expect(r.mode).toBe("wait");
    expect(r.best_pay_date).toBe("2099-07-10"); // latest on ties
    expect(r.uf_best).toBe(40_000);
    expect(r.uf_now).toBe(40_000);
    expect(r.horizon_limited).toBe(false);
    expect(r.next_billing_month).toBe("2099-07");
  });

  it("falling month → wait, best date at window end (cheapest, latest)", () => {
    const r = decideMortgageUfReminder(decisionInput({ ufByYmd: ufSeries(40_000, -10) }));
    expect(r.show).toBe(true);
    expect(r.mode).toBe("wait");
    expect(r.best_pay_date).toBe("2099-07-10");
    expect(r.uf_best).toBeLessThan(r.uf_now!);
  });

  it("flat then rising at the month boundary → best sits at the pre-rise minimum", () => {
    // Flat 06-11..07-01, then rising 07-02..07-10.
    const m = ufSeries(40_000, 0);
    let v = 40_000;
    for (const d of ["2099-07-02", "2099-07-03", "2099-07-04", "2099-07-05", "2099-07-06", "2099-07-07", "2099-07-08", "2099-07-09", "2099-07-10"]) {
      v += 15;
      m.set(d, v);
    }
    const r = decideMortgageUfReminder(decisionInput({ today_ymd: "2099-06-15", ufByYmd: m }));
    expect(r.show).toBe(true);
    expect(r.mode).toBe("wait");
    expect(r.best_pay_date).toBe("2099-07-01"); // last flat day before the rise
  });

  it("horizon_limited when UF is only published up to a date short of window end", () => {
    // Flat, but only published through 2099-06-25 (post-cierre known, later dates unknown).
    const m = new Map<string, number>();
    for (const [d, v] of ufSeries(40_000, 0)) {
      if (d <= "2099-06-25") m.set(d, v);
    }
    const r = decideMortgageUfReminder(decisionInput({ today_ymd: "2099-06-15", ufByYmd: m }));
    expect(r.show).toBe(true);
    expect(r.best_pay_date).toBe("2099-06-25");
    expect(r.horizon_limited).toBe(true);
  });

  it("today at the UF minimum (last day) → pay_today", () => {
    const r = decideMortgageUfReminder(decisionInput({ today_ymd: "2099-07-10", ufByYmd: ufSeries(40_000, 0) }));
    expect(r.show).toBe(true);
    expect(r.mode).toBe("pay_today");
    expect(r.best_pay_date).toBe("2099-07-10");
  });

  it("past cierre, still unpaid, flat → wait (keep floating to window end)", () => {
    const r = decideMortgageUfReminder(decisionInput({ today_ymd: "2099-06-25", ufByYmd: ufSeries(40_000, 0) }));
    expect(r.show).toBe(true);
    expect(r.mode).toBe("wait");
    expect(r.best_pay_date).toBe("2099-07-10");
    expect(r.uf_now).toBe(40_000); // uf at today (2099-06-25), flat
  });

  it("paid → already_paid (hidden), even when UF is flat", () => {
    const r = decideMortgageUfReminder(decisionInput({ paid: true, ufByYmd: ufSeries(40_000, 0) }));
    expect(r.show).toBe(false);
    expect(r.reason).toBe("already_paid");
  });

  it("missing window_start or post-cierre UF → uf_unavailable", () => {
    const m = ufSeries(40_000, 0);
    m.delete("2099-06-21"); // post-cierre day unknown
    const r = decideMortgageUfReminder(decisionInput({ ufByYmd: m }));
    expect(r.show).toBe(false);
    expect(r.reason).toBe("uf_unavailable");
  });
});

/**
 * Assembler against the isolated Vitest CC master (21→20 config, last4 0000). Far-future 2099
 * dates keep the fixture clear of generated data; own uf_daily rows for determinism.
 */
describe("buildMortgageUfReminder (assembler, synthetic fixture)", () => {
  const masterId = getVitestSantanderCcMasterAccountId();
  const insertedUfDates: string[] = [];
  let paidMovementId: number | null = null;
  let paidAccountId: number | null = null;

  beforeAll(() => {
    if (masterId == null) return;

    // One statement + a mortgage-merchant line on the fixture master.
    const stmt = db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, card_last4)
         VALUES (?, 'vitest', 'vitest-mortgage-uf.pdf', '2099-06-20', '2099-05-21', '2099-06-20', '0000')`
      )
      .run(masterId);
    db.prepare(
      `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount_clp)
       VALUES (?, '2099-06-11', 'TOKU *METLIFE HIPOTE', 1200000)`
    ).run(Number(stmt.lastInsertRowid));

    // UF series: flat 06-11 & 06-21 (post-cierre) → qualifies; add a couple more days.
    const uf: ReadonlyArray<[string, number]> = [
      ["2099-06-11", 40_000],
      ["2099-06-21", 40_000],
      ["2099-07-10", 40_000],
    ];
    for (const [date, clp] of uf) {
      const had = db.prepare(`SELECT 1 FROM uf_daily WHERE date = ?`).get(date) != null;
      if (!had) {
        db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(date, clp);
        insertedUfDates.push(date);
      }
    }
  });

  afterAll(() => {
    if (masterId != null) wipeVitestCcFixtureData();
    for (const date of insertedUfDates) db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(date);
    if (paidAccountId != null) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(paidAccountId); // cascades depto_payments
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(paidAccountId);
    }
  });

  it("resolves the paying card and shows a wait reminder in a flat month", () => {
    if (masterId == null) return;
    const r = buildMortgageUfReminder("2099-06-11");
    expect(r.card_last4).toBe("0000");
    expect(r.cycle_month).toBe("2099-06");
    expect(r.cierre_iso).toBe("2099-06-20");
    expect(r.pay_after_iso).toBe("2099-06-21");
    expect(r.next_billing_month).toBe("2099-07");
    expect(r.show).toBe(true);
    expect(r.mode).toBe("wait");
  });

  it("hides with uf_unavailable when the post-cierre UF is not published", () => {
    if (masterId == null) return;
    // July cycle window (2099-07-11 …) has no seeded UF rows.
    const r = buildMortgageUfReminder("2099-07-11");
    expect(r.show).toBe(false);
    expect(r.reason).toBe("uf_unavailable");
  });

  it("hides with already_paid once a numeric-cuota mortgage payment is logged in the window", () => {
    if (masterId == null) return;
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    paidAccountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, account_kind)
           VALUES (?, 'Vitest mortgage payer', NULL, 'vitest|mortgage-uf|payer', 'master')`
        )
        .run(group.id).lastInsertRowid
    );

    // A prepago in the window must NOT count as paid.
    const prepagoMov = db
      .prepare(`INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, '2099-06-12', NULL)`)
      .run(paidAccountId, 1_000_000);
    insertDeptoPaymentRow({
      movement_id: Number(prepagoMov.lastInsertRowid),
      kind: "mortgage",
      origin: "manual",
      cuota: "prepago 1",
      amount_uf: null,
      credito_restante_uf: null,
      valor_vivienda_uf: null,
      valor_neto_uf: null,
      valor_neto_clp: null,
      pagado_neto_uf: null,
      pago_acumulado_clp: null,
      min_uf: null,
      amortizacion_clp: null,
      amortizacion_uf: null,
      amortizacion_ext_clp: null,
      amortizacion_ext_uf: null,
      interes_clp: null,
      interes_uf: null,
      incendio_clp: null,
      desgravamen_clp: null,
    });
    expect(buildMortgageUfReminder("2099-06-11").reason).not.toBe("already_paid");

    // A regular numeric cuota → already_paid.
    const paidMov = db
      .prepare(`INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, '2099-06-11', NULL)`)
      .run(paidAccountId, 1_200_000);
    paidMovementId = Number(paidMov.lastInsertRowid);
    insertDeptoPaymentRow({
      movement_id: paidMovementId,
      kind: "mortgage",
      origin: "manual",
      cuota: "999",
      amount_uf: null,
      credito_restante_uf: null,
      valor_vivienda_uf: null,
      valor_neto_uf: null,
      valor_neto_clp: null,
      pagado_neto_uf: null,
      pago_acumulado_clp: null,
      min_uf: null,
      amortizacion_clp: null,
      amortizacion_uf: null,
      amortizacion_ext_clp: null,
      amortizacion_ext_uf: null,
      interes_clp: null,
      interes_uf: null,
      incendio_clp: null,
      desgravamen_clp: null,
    });

    // Cycle 2099-06 is now paid; today 2099-06-11 looks ahead to 2099-07 (no UF) → uf_unavailable.
    const r = buildMortgageUfReminder("2099-06-11");
    expect(r.reason).toBe("uf_unavailable");
    expect(r.cycle_month).toBe("2099-07");
  });
});
