import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MortgageLenderStatementApplyDetails, MortgageLenderStatementPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import { DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, deptoLedgerForLoan } from "./deptoLedgerFromMovements.js";
import { receiveIngest } from "./ingestHandlers.js";
import { buildDeptoPaymentScenarioRows } from "./mortgageScenarioPayments.js";
import { latestMortgageLenderQuoteDueOn, metlifeReadInputs, nextCuotaQuoteForLoan } from "./mortgageLenderQuotes.js";

/**
 * Synthetic depto: a property + mortgage (the mortgage's import key carries the METLIFE
 * `lender_pattern` role) under the lean test DB's own asset groups, a pie and cuota 1 written with
 * the real table helpers, far in the past so they never collide with generated data. Own uf_daily
 * rows: the apply derives the split at them.
 */
const MORTGAGE_IMPORT_KEY = "import:excel|key=mortgage";
const UF = 40_000;
const FIXTURE_UF = ["1990-01-10", "1990-02-11", "1990-03-11"];
const CREDIT = "CR-FIXTURE-1";

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "1990-02-11",
    amount_clp: 0,
    credito_restante_uf: null,
    min_uf: null,
    max_uf: null,
    amortizacion_clp: null,
    amortizacion_ext_clp: null,
    interes_clp: null,
    incendio_clp: null,
    desgravamen_clp: null,
    ...overrides,
  };
}

type History = MortgageLenderStatementPayload["history"][number];

const PAID_1: History = {
  cuota: 1,
  due_on: "1990-03-10",
  status: "paid",
  paid_on: "1990-02-11",
  amortization_pesos: 558_400,
  extra_amortization_pesos: 0,
  interest_pesos: 601_500,
  default_interest_pesos: 0,
  collection_fee_pesos: 0,
  total_pesos: 1_200_000,
  insurance: { fire_uf: 0.5013, life_uf: 0.5013, other_uf: null, fire_pesos: 20_050, life_pesos: 20_050, other_pesos: 0 },
};
const PAID_2: History = {
  cuota: 2,
  due_on: "1990-04-10",
  status: "paid",
  paid_on: "1990-03-11",
  amortization_pesos: 96_000,
  extra_amortization_pesos: 360_000,
  interest_pesos: 300_000,
  default_interest_pesos: 0,
  collection_fee_pesos: 0,
  total_pesos: 800_000,
  insurance: { fire_uf: 1, life_uf: 0.1, other_uf: null, fire_pesos: 40_000, life_pesos: 4_000, other_pesos: 0 },
};
const pendingHistory = (cuota: number, due_on: string): History => ({
  cuota,
  due_on,
  status: "pending",
  paid_on: null,
  amortization_pesos: null,
  extra_amortization_pesos: null,
  interest_pesos: null,
  default_interest_pesos: null,
  collection_fee_pesos: null,
  total_pesos: null,
  insurance: { fire_uf: 1, life_uf: 0.1, other_uf: null, fire_pesos: null, life_pesos: null, other_pesos: null },
});
/** A quote: fee 20 UF at 40.000 = amortization + interest + 1,1 UF of insurance. */
const pending = (cuota: number, due_on: string, min_uf: number, max_uf: number): MortgageLenderStatementPayload["pending"][number] => ({
  cuota,
  period: due_on.slice(0, 4) + due_on.slice(5, 7),
  due_on,
  fee_uf: 20,
  fee_pesos: 800_000,
  min_uf,
  min_pesos: Math.round(min_uf * UF),
  max_uf,
  max_pesos: Math.round(max_uf * UF),
  amortization_pesos: 456_000,
  interest_pesos: 300_000,
  default_interest_pesos: 0,
  collection_fee_pesos: 0,
});

/** Before cuota 2 is paid: cuota 1 posted (balance 3000 after it), cuota 2 quoted. */
const BEFORE: MortgageLenderStatementPayload = {
  lender: "metlife",
  credit_number: CREDIT,
  read_at: "1990-03-11T10:00:00-03:00",
  credit: { balance_uf: 3000, original_debt_uf: null, total_cuotas: 360, last_paid_cuota: 1, last_paid_on: "1990-02-11", last_paid_pesos: 1_200_000 },
  pending: [pending(2, "1990-04-10", 11, 80)],
  history: [pendingHistory(2, "1990-04-10"), PAID_1],
};
/** After cuota 2 is paid: its parts and the balance after it, cuota 3 quoted. */
const AFTER: MortgageLenderStatementPayload = {
  lender: "metlife",
  credit_number: CREDIT,
  read_at: "1990-03-12T10:00:00-03:00",
  credit: { balance_uf: 2988.6, original_debt_uf: null, total_cuotas: 360, last_paid_cuota: 2, last_paid_on: "1990-03-11", last_paid_pesos: 800_000 },
  pending: [pending(3, "1990-05-10", 10.9, 79.8)],
  history: [pendingHistory(3, "1990-05-10"), PAID_2, PAID_1],
};

function send(p: MortgageLenderStatementPayload, write: boolean) {
  const r = receiveIngest("mortgage.lender_statement", p, { source: { channel: "web_session", ref: p.read_at }, dryRun: !write });
  return { status: r.status, details: r.details as unknown as MortgageLenderStatementApplyDetails, conflicts: r.conflicts };
}

describe("applyMortgageLenderStatement (synthetic depto)", () => {
  let propertyId: number | null = null;
  let mortgageId: number | null = null;
  const insertedUf: string[] = [];
  let skip = false;

  beforeAll(() => {
    // A DB that tracks a real depto keeps its own data; the fixture only runs on the lean test DB.
    skip = db.prepare(`SELECT 1 FROM accounts WHERE import_key IN (?, ?)`).get(DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, MORTGAGE_IMPORT_KEY) != null;
    if (skip) return;
    for (const date of FIXTURE_UF) {
      if (!db.prepare(`SELECT 1 FROM uf_daily WHERE date = ?`).get(date)) {
        db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(date, UF);
        insertedUf.push(date);
      }
    }
    const group = (slug: string) => {
      const g = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
      if (!g) throw new Error(`test DB lacks asset group ${slug}`);
      return g.id;
    };
    const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`);
    propertyId = Number(ins.run(group("real_estate__property"), "Depto fixture", DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY).lastInsertRowid);
    mortgageId = Number(ins.run(group("liabilities__mortgage"), "Hipoteca fixture", MORTGAGE_IMPORT_KEY, MORTGAGE_IMPORT_KEY).lastInsertRowid);
    const rows: DeptoDividendosPaymentRow[] = [
      paymentRow({ cuota: "pie", occurred_on: "1990-01-10", amount_clp: 58_000_000, credito_restante_uf: 3950 }),
      paymentRow({
        cuota: "1",
        occurred_on: "1990-02-11",
        amount_clp: 1_200_000,
        credito_restante_uf: 3000,
        amortizacion_clp: 558_400,
        amortizacion_ext_clp: 0,
        interes_clp: 601_500,
        incendio_clp: 20_050,
        desgravamen_clp: 20_050,
        min_uf: 30,
      }),
    ];
    const insMov = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`);
    upsertPropertyAppraisalUf(propertyId, "1990-01-10", 5400);
    for (const r of rows) {
      const prop = insMov.run(propertyId, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("property", r.cuota, false), null);
      insertLoanPaymentRow({ movement_id: Number(prop.lastInsertRowid), loan_account_id: mortgageId, leg: "property", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
      if (r.cuota !== "pie") {
        const mort = insMov.run(mortgageId, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("loan", r.cuota, false), "pago_cuota_hipotecario");
        insertLoanPaymentRow({ movement_id: Number(mort.lastInsertRowid), loan_account_id: mortgageId, leg: "loan", origin: "import", ...loanPaymentColumnsFromPaymentRow(r) });
      }
    }
  });

  afterAll(() => {
    db.prepare(`DELETE FROM mortgage_payment_receipts WHERE credit_number = ?`).run(CREDIT);
    for (const id of [propertyId, mortgageId]) {
      if (id == null) continue;
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    for (const date of insertedUf) db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(date);
  });

  const quoteCount = () => (db.prepare(`SELECT COUNT(*) AS c FROM mortgage_lender_quotes WHERE credit_number = ?`).get(CREDIT) as { c: number }).c;
  const movementCount = () => (db.prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id IN (?, ?)`).get(propertyId, mortgageId) as { c: number }).c;

  it("a reading before the payment checks cuota 1 and stores cuota 2's quote", (ctx) => {
    if (skip) ctx.skip();
    const r = send(BEFORE, true);
    expect(r.status).toBe("applied");
    expect(r.details.quote).toEqual({ cuota: 2, due_on: "1990-04-10", stored: true, first_seen_at: BEFORE.read_at });
    expect(r.details.paid).toEqual([{ cuota: 1, outcome: "matches", detail: "equal to the ledger" }]);
    expect(quoteCount()).toBe(1);
    expect(latestMortgageLenderQuoteDueOn(mortgageId!)).toBe("1990-04-10");
    // The scenario table and «Próximos pagos» read it for the next cuota.
    expect(nextCuotaQuoteForLoan(mortgageId!, deptoLedgerForLoan(mortgageId!))).toEqual({ cuota: 2, min_uf: 11, max_uf: 80 });
    const next = buildDeptoPaymentScenarioRows(deptoLedgerForLoan(mortgageId!), nextCuotaQuoteForLoan(mortgageId!, deptoLedgerForLoan(mortgageId!))).at(-1)!;
    expect(next).toMatchObject({ cuota: "2", quoted: true, min_payment_uf: 11 });
    // The same reading again stores nothing.
    expect(send({ ...BEFORE, read_at: "1990-03-11T11:00:00-03:00" }, true).details.quote).toMatchObject({ stored: false, first_seen_at: BEFORE.read_at });
    expect(quoteCount()).toBe(1);
  });

  it("a dry run of the reading after the payment reports the write and leaves nothing", (ctx) => {
    if (skip) ctx.skip();
    const before = movementCount();
    const r = send(AFTER, false);
    expect(r.status).toBe("applied");
    expect(r.details.paid.find((p) => p.cuota === 2)).toMatchObject({ outcome: "written" });
    expect(movementCount()).toBe(before);
    expect(quoteCount()).toBe(1);
  });

  it("a paid cuota that is not the credit's last waits (no balance after it)", (ctx) => {
    if (skip) ctx.skip();
    const r = send({ ...AFTER, credit: { ...AFTER.credit, last_paid_cuota: null } }, false);
    expect(r.details.paid.find((p) => p.cuota === 2)).toMatchObject({ outcome: "waiting" });
  });

  it("a receipt stating another amount for the cuota's due month is a conflict, nothing written", (ctx) => {
    if (skip) ctx.skip();
    const before = movementCount();
    db.prepare(
      `INSERT INTO mortgage_payment_receipts (lender, transaction_id, paid_on, amount_clp, credit_number, dividend_number, due_on, card_account_id, message_id)
       VALUES ('metlife', 'tx-fixture', '1990-03-11', 799999, ?, ?, '1990-04-10', ?, 'msg-fixture')`
    ).run(CREDIT, `${CREDIT}199004`, mortgageId);
    try {
      const r = send(AFTER, true);
      expect(r.status).toBe("conflict");
      expect(r.conflicts?.map((c) => c.fields[0])).toContain("receipt tx-fixture amount");
      expect(movementCount()).toBe(before);
      // The scheduler sees a receipt the ledger lacks.
      expect(metlifeReadInputs()).toMatchObject({ hasLoan: true, ledgerLastDueMonth: "1990-03" });
    } finally {
      db.prepare(`DELETE FROM mortgage_payment_receipts WHERE transaction_id = 'tx-fixture'`).run();
    }
  });

  it("the reading after the payment writes cuota 2 with the lender's parts, the balance after and the quote's min/max", (ctx) => {
    if (skip) ctx.skip();
    const r = send(AFTER, true);
    expect(r.status).toBe("applied");
    expect(r.details.paid).toEqual([
      { cuota: 1, outcome: "matches", detail: "equal to the ledger" },
      expect.objectContaining({ cuota: 2, outcome: "written" }),
    ]);
    expect(r.details.quote).toMatchObject({ cuota: 3, stored: true });
    const row = deptoLedgerForLoan(mortgageId!).find((x) => x.cuota === "2")!;
    expect(row).toMatchObject({
      occurred_on: "1990-03-11",
      pago_clp: 800_000,
      amortizacion_clp: 96_000,
      amortizacion_ext_clp: 360_000,
      interes_clp: 300_000,
      incendio_clp: 40_000,
      desgravamen_clp: 4_000,
      credito_restante_uf: 2988.6,
      min_uf: 11,
      max_uf: 80,
    });
    // Sent again: cuota 2 now matches the ledger, the identical quote stores nothing.
    const again = send({ ...AFTER, read_at: "1990-03-12T11:00:00-03:00" }, true);
    expect(again.details.paid.find((p) => p.cuota === 2)).toEqual({ cuota: 2, outcome: "matches", detail: "equal to the ledger" });
    expect(again.details.quote).toMatchObject({ stored: false });
  });

  it("a paid cuota that differs from the ledger is a conflict listing every field", (ctx) => {
    if (skip) ctx.skip();
    const quotes = quoteCount();
    const wrong: History = { ...PAID_2, interest_pesos: 300_100, amortization_pesos: 95_900, paid_on: "1990-03-12" };
    const r = send({ ...AFTER, read_at: "1990-03-13T10:00:00-03:00", pending: [pending(3, "1990-05-10", 10.95, 79.8)], history: [pendingHistory(3, "1990-05-10"), wrong, PAID_1] }, true);
    expect(r.status).toBe("conflict");
    expect(r.conflicts?.map((c) => c.fields[0]).sort()).toEqual(["interest", "paid_on", "principal"]);
    // Rolled back: the changed quote was not stored either.
    expect(quoteCount()).toBe(quotes);
  });
});
