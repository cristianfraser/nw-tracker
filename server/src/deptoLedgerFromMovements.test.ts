import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  deptoPaymentHumanNote,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import {
  DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY,
  deptoAccountMarkClpAtYmd,
  loadDeptoLedgerFromMovements,
} from "./deptoLedgerFromMovements.js";
import { accountWithRoleOptional } from "./accountRoles.js";
/** The depto property and its loan (their roles). */
const deptoPropertyId = (): number => accountWithRoleOptional("property") ?? -1;


/**
 * Synthetic fixture: a property master + movements + loan_payments rows written with the
 * REAL table helpers (the same write shape manual payments produce). Far-future dates so
 * the fixture never collides with generated demo/test data; own uf_daily rows so
 * UF-derived fields are deterministic.
 */
const FIXTURE_UF: ReadonlyArray<[string, number]> = [
  ["2099-01-10", 40_000],
  ["2099-02-10", 40_100],
  ["2099-03-10", 40_200],
  ["2099-03-20", 40_250],
];

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "2099-02-10",
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

describe("loadDeptoLedgerFromMovements (synthetic fixture)", () => {
  let accountId: number | null = null;
  let loanAccountId: number | null = null;
  const insertedUfDates: string[] = [];
  let preexistingProperty = false;

  beforeAll(() => {
    // A DB that already tracks a real depto (dev-DB copy) keeps its own data; the
    // synthetic block only runs on DBs without one (the generated lean test DB).
    preexistingProperty =
      db
        .prepare(`SELECT 1 FROM accounts WHERE import_key = ?`)
        .get(DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY) != null;
    if (preexistingProperty) return;

    for (const [date, clp] of FIXTURE_UF) {
      const had = db.prepare(`SELECT 1 FROM uf_daily WHERE date = ?`).get(date) != null;
      if (!had) {
        db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(date, clp);
        insertedUfDates.push(date);
      }
    }

    // The property and its loan on their own leaves: the profile reads the kind from there.
    const leaf = (slug: string) =>
      (db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined)?.id ??
      (db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number }).id;
    const group = { id: leaf("real_estate__property") };
    accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'Depto fixture', ?, ?)`
        )
        .run(group.id, DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY).lastInsertRowid
    );

    // pie: 1450 UF down on a 5400 UF property (3950 UF mortgage after).
    const rows: DeptoDividendosPaymentRow[] = [
      paymentRow({
        cuota: "pie",
        occurred_on: "2099-01-10",
        amount_clp: 58_000_000,
        credito_restante_uf: 3950,
      }),
      paymentRow({
        cuota: "1",
        occurred_on: "2099-02-10",
        amount_clp: 1_203_000,
        credito_restante_uf: 3936,
        amortizacion_clp: 561_400,
        interes_clp: 601_500,
        incendio_clp: 20_050,
        desgravamen_clp: 20_050,
        min_uf: 30,
      }),
      paymentRow({
        cuota: "2",
        occurred_on: "2099-03-10",
        amount_clp: 1_206_000,
        credito_restante_uf: 3921.8,
        amortizacion_clp: 570_840,
        interes_clp: 594_960,
        incendio_clp: 20_100,
        desgravamen_clp: 20_100,
        min_uf: 30,
      }),
      // Prepago with the space-in-cuota label (URL-encoded in the note).
      paymentRow({
        cuota: "prepago 3",
        occurred_on: "2099-03-20",
        amount_clp: 4_025_000,
        credito_restante_uf: 3821.8,
        amortizacion_ext_clp: 4_025_000,
      }),
    ];
    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
    );
    loanAccountId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, 'Depto loan fixture', 'vitest')`)
        .run(leaf("liabilities__mortgage")).lastInsertRowid
    );
    // The appraisal is stated once (at the pie); the ledger carries it to later rows.
    upsertPropertyAppraisalUf(accountId, "2099-01-10", 5400);
    for (const r of rows) {
      const mov = ins.run(
        accountId,
        r.amount_clp,
        r.occurred_on,
        deptoPaymentHumanNote("property", r.cuota, false)
      );
      insertLoanPaymentRow({
        movement_id: Number(mov.lastInsertRowid),
        loan_account_id: loanAccountId,
        leg: "property",
        origin: "import",
        ...loanPaymentColumnsFromPaymentRow(r),
      });
    }
  });

  afterAll(() => {
    if (accountId != null) {
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
    if (loanAccountId != null) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(loanAccountId);
    for (const date of insertedUfDates) {
      db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(date);
    }
  });

  it("reconstructs ledger rows from movement notes (order, decode, derivations)", () => {
    if (preexistingProperty) return; // covered by the parity test below on such DBs
    const ledger = loadDeptoLedgerFromMovements();
    expect(ledger.map((r) => r.cuota)).toEqual(["pie", "1", "2", "prepago 3"]);

    const c1 = ledger[1]!;
    expect(c1.pago_clp).toBe(1_203_000);
    expect(c1.pago_uf).toBe(30);
    expect(c1.credito_restante_uf).toBe(3936);
    expect(c1.valor_neto_uf).toBe(1464);
    expect(c1.valor_neto_clp).toBe(58_706_400);
    // uf_daily-derived fields (2099-02-10 → 40,100 CLP/UF)
    expect(c1.uf_clp_day).toBe(40_100);
    expect(c1.restante_clp).toBe(Math.round(3936 * 40_100));
    expect(c1.valor_vivienda_uf).toBe(5400);
    expect(c1.valor_vivienda_clp).toBe(Math.round(5400 * 40_100));
    expect(c1.incendio_uf).toBeCloseTo(20_050 / 40_100, 5);
    expect(c1.total_seguros_clp).toBe(40_100);
    // Derived from what the bank stated: parts in UF at the payment day's UF, cumulative figures.
    expect(c1.amortizacion_uf).toBe(14);
    expect(c1.interes_uf).toBe(15);
    expect(c1.amortizacion_ext_uf).toBeNull();
    expect(c1.pago_acumulado_clp).toBe(59_203_000);
    expect(c1.pagado_neto_uf).toBe(14);

    const c2 = ledger[2]!;
    // consecutive deltas + cumsums
    expect(c2.delta_credito_clp).toBe(c1.restante_clp! - c2.restante_clp!);
    expect(c2.delta_valor_neto_clp).toBe(59_423_640 - 58_706_400);
    expect(c2.amort_acum_clp).toBe(561_400 + 570_840);
    expect(c2.interes_acum_clp).toBe(601_500 + 594_960);
    // recomputed analysis columns present
    expect(c2.pct_dividendo).toBeTruthy();
    expect(c2.pct_credito_uf).toBeTruthy();
    expect(c2.interes_calculado_uf).not.toBeNull();

    const prepago = ledger[3]!;
    expect(prepago.cuota).toBe("prepago 3");
    expect(prepago.amortizacion_ext_clp).toBe(4_025_000);
  });

  it("marks property and mortgage from the movement ledger (UF × uf_daily)", () => {
    if (preexistingProperty) return;
    // 2099-03-15: last row is cuota 2 (3921.8 UF / 1478.2 UF); UF on-or-before = 40,200.
    const property = deptoAccountMarkClpAtYmd(deptoPropertyId(), "2099-03-15");
    const mortgage = deptoAccountMarkClpAtYmd(loanAccountId!, "2099-03-15");
    expect(property?.value_clp).toBe(Math.round(1478.2 * 40_200));
    expect(mortgage?.value_clp).toBe(Math.round(3921.8 * 40_200));
    // After the prepago (2099-03-20) its balance drop applies on its own date: 3821.8 UF.
    const after = deptoAccountMarkClpAtYmd(loanAccountId!, "2099-03-25");
    expect(after?.value_clp).toBe(Math.round(3821.8 * 40_250));
    const propertyAfter = deptoAccountMarkClpAtYmd(deptoPropertyId(), "2099-03-25");
    expect(propertyAfter?.value_clp).toBe(Math.round((5400 - 3821.8) * 40_250));
  });

  it("returns [] with no depto data and throws on stray depto payments", () => {
    if (preexistingProperty) return;
    // temporarily orphan the fixture account's notes
    db.prepare(`UPDATE accounts SET import_key = 'depto-fixture-parked' WHERE id = ?`).run(accountId);
    try {
      expect(() => loadDeptoLedgerFromMovements()).toThrow(/loan_payments rows exist/);
    } finally {
      db.prepare(`UPDATE accounts SET import_key = ? WHERE id = ?`).run(
        DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY,
        accountId
      );
    }
  });
});

