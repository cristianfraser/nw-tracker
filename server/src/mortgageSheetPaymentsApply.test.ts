import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MortgageSheetPaymentRow, MortgageSheetPaymentsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import {
  deptoPaymentColumnsFromPaymentRow,
  deptoPaymentHumanNote,
  insertDeptoPaymentRow,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import { DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { applyMortgageSheetPayments } from "./mortgageSheetPaymentsApply.js";

/**
 * Synthetic depto: a property + mortgage master under the lean test DB's own asset groups, a pie
 * and cuota 1 written with the real table helpers, far in the past so they never collide with
 * generated data and are «due» for the import. Own uf_daily rows: the import checks the sheet's
 * UF against them and derives the split at them.
 */
const MORTGAGE_IMPORT_KEY = "import:excel|key=mortgage";
const UF = 40_000;
const FIXTURE_UF: ReadonlyArray<[string, number]> = [
  ["1990-01-10", UF],
  ["1990-02-11", UF],
  ["1990-03-11", UF],
];

function paymentRow(overrides: Partial<DeptoDividendosPaymentRow>): DeptoDividendosPaymentRow {
  return {
    cuota: "1",
    occurred_on: "1990-02-11",
    amount_clp: 0,
    amount_uf: null,
    uf_clp_day: null,
    credito_restante_uf: null,
    valor_vivienda_uf: null,
    valor_neto_uf: null,
    valor_neto_clp: null,
    pagado_neto_uf: null,
    pago_acumulado_clp: null,
    min_uf: null,
    max_uf: null,
    amortizacion_clp: null,
    amortizacion_uf: null,
    amortizacion_ext_clp: null,
    amortizacion_ext_uf: null,
    interes_clp: null,
    interes_uf: null,
    incendio_clp: null,
    desgravamen_clp: null,
    ...overrides,
  };
}

function sheetRow(over: Partial<MortgageSheetPaymentRow>): MortgageSheetPaymentRow {
  return {
    kind: "cuota",
    label: "2",
    paid_on: "1990-03-11",
    uf_day: UF,
    pago_clp: 800_000,
    pago_uf: 20,
    interes_clp: 300_000,
    interes_uf: 7.5,
    min_uf: 11,
    max_uf: 80,
    incendio_clp: 40_000,
    incendio_uf: 1,
    desgravamen_clp: 4_000,
    desgravamen_uf: 0.1,
    amortizacion_clp: 96_000,
    amortizacion_uf: 2.4,
    amortizacion_ext_clp: 360_000,
    amortizacion_ext_uf: 9,
    credito_restante_uf: 2988.6,
    valor_vivienda_uf: 5400,
    ...over,
  };
}

const PIE = sheetRow({
  kind: "pie",
  label: "pie",
  paid_on: "1990-01-10",
  pago_clp: 58_000_000,
  pago_uf: 1450,
  interes_clp: null,
  interes_uf: null,
  min_uf: null,
  max_uf: null,
  incendio_clp: null,
  incendio_uf: null,
  desgravamen_clp: null,
  desgravamen_uf: null,
  amortizacion_clp: null,
  amortizacion_uf: null,
  amortizacion_ext_clp: null,
  amortizacion_ext_uf: null,
  credito_restante_uf: 3950,
});
const CUOTA_1 = sheetRow({
  label: "1",
  paid_on: "1990-02-11",
  pago_clp: 1_200_000,
  pago_uf: 30,
  interes_clp: 601_500,
  interes_uf: 15.0375,
  min_uf: 30,
  max_uf: 80.5,
  incendio_clp: 20_050,
  incendio_uf: 0.5013,
  desgravamen_clp: 20_050,
  desgravamen_uf: 0.5013,
  amortizacion_clp: 558_400,
  amortizacion_uf: 13.96,
  amortizacion_ext_clp: 0,
  amortizacion_ext_uf: 0,
  credito_restante_uf: 3000,
});
const CUOTA_2 = sheetRow({});
const CUOTA_3_FUTURE = sheetRow({ label: "3", paid_on: "2099-04-11", credito_restante_uf: 2977.2 });

function payload(rows: MortgageSheetPaymentRow[], apply: boolean, sha = "1".repeat(64)): MortgageSheetPaymentsPayload {
  return {
    apply,
    document: { name: "fixture.numbers", sha256: sha, size: 1, modified_at: "1990-03-11T12:00:00Z" },
    sheet: "depto",
    table: "dividendos",
    rows,
    projected: ["4"],
    accepted: [],
  };
}

describe("applyMortgageSheetPayments (synthetic depto)", () => {
  let propertyId: number | null = null;
  let mortgageId: number | null = null;
  const insertedUf: string[] = [];
  let skip = false;

  beforeAll(() => {
    // A DB that tracks a real depto keeps its own data; the fixture only runs on the lean test DB.
    skip = db.prepare(`SELECT 1 FROM accounts WHERE import_key IN (?, ?)`).get(DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, MORTGAGE_IMPORT_KEY) != null;
    if (skip) return;
    for (const [date, clp] of FIXTURE_UF) {
      if (!db.prepare(`SELECT 1 FROM uf_daily WHERE date = ?`).get(date)) {
        db.prepare(`INSERT INTO uf_daily (date, clp_per_uf) VALUES (?, ?)`).run(date, clp);
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
      paymentRow({
        cuota: "pie",
        occurred_on: "1990-01-10",
        amount_clp: 58_000_000,
        amount_uf: 1450,
        credito_restante_uf: 3950,
        valor_vivienda_uf: 5400,
        valor_neto_uf: 1450,
        valor_neto_clp: 58_000_000,
        pago_acumulado_clp: 58_000_000,
      }),
      paymentRow({
        cuota: "1",
        occurred_on: "1990-02-11",
        amount_clp: 1_200_000,
        amount_uf: 30,
        credito_restante_uf: 3000,
        valor_vivienda_uf: 5400,
        valor_neto_uf: 2400,
        valor_neto_clp: 96_000_000,
        pago_acumulado_clp: 59_200_000,
        amortizacion_clp: 558_400,
        amortizacion_uf: 13.96,
        amortizacion_ext_clp: 0,
        interes_clp: 601_500,
        interes_uf: 15.0375,
        incendio_clp: 20_050,
        desgravamen_clp: 20_050,
        min_uf: 30,
        pagado_neto_uf: 1463.96,
      }),
    ];
    const insMov = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`);
    for (const r of rows) {
      const prop = insMov.run(propertyId, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("dividendos", r.cuota, false), null);
      insertDeptoPaymentRow({ movement_id: Number(prop.lastInsertRowid), kind: "dividendos", origin: "import", ...deptoPaymentColumnsFromPaymentRow(r) });
      if (r.cuota !== "pie") {
        const mort = insMov.run(mortgageId, r.amount_clp, r.occurred_on, deptoPaymentHumanNote("mortgage", r.cuota, false), "pago_cuota_hipotecario");
        insertDeptoPaymentRow({ movement_id: Number(mort.lastInsertRowid), kind: "mortgage", origin: "import", ...deptoPaymentColumnsFromPaymentRow(r) });
      }
    }
  });

  afterAll(() => {
    for (const id of [propertyId, mortgageId]) {
      if (id == null) continue;
      db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
    db.prepare(`DELETE FROM mortgage_sheet_imports WHERE document_name = 'fixture.numbers'`).run();
    for (const date of insertedUf) db.prepare(`DELETE FROM uf_daily WHERE date = ?`).run(date);
  });

  const movementCount = () => (db.prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id IN (?, ?)`).get(propertyId, mortgageId) as { c: number }).c;

  it("reports without writing: stored rows checked, a posted cuota written, a future one not due", () => {
    if (skip) return;
    const before = movementCount();
    const r = applyMortgageSheetPayments(payload([PIE, CUOTA_1, CUOTA_2, CUOTA_3_FUTURE], false));
    expect(r.status).toBe("applied");
    expect(r.details.applied).toBe(false);
    expect(r.details.drift).toEqual([]);
    expect(r.details.rows.map((x) => [x.label, x.status, x.filled])).toEqual([
      ["pie", "checked", []],
      ["1", "checked", ["max_uf"]],
      ["2", "written", []],
      ["3", "not_due", []],
    ]);
    expect(movementCount()).toBe(before);
    expect((db.prepare(`SELECT max_uf FROM depto_payments WHERE cuota = '1' AND kind = 'mortgage'`).get() as { max_uf: number | null }).max_uf).toBeNull();
    // The memoized ledger must not keep the rolled-back row or the rolled-back max_uf fill.
    const ledger = loadDeptoLedgerFromMovements();
    expect(ledger.map((x) => x.cuota)).toEqual(["pie", "1"]);
    expect(ledger.find((x) => x.cuota === "1")!.max_uf).toBeNull();
  });

  it("refuses a sheet row that disagrees with the ledger and writes nothing", () => {
    if (skip) return;
    const before = movementCount();
    const r = applyMortgageSheetPayments(payload([PIE, { ...CUOTA_1, interes_clp: 601_510, amortizacion_clp: 558_390 }, CUOTA_2], true));
    expect(r.status).toBe("conflict");
    expect(r.details.drift.map((d) => [d.label, d.field, d.sheet, d.ledger])).toEqual([
      ["1", "interes_clp", 601_510, 601_500],
      ["1", "amortizacion_clp", 558_390, 558_400],
    ]);
    expect(movementCount()).toBe(before);
    expect(db.prepare(`SELECT 1 FROM mortgage_sheet_imports WHERE document_name = 'fixture.numbers'`).get()).toBeUndefined();
  });

  it("reports a declared difference instead of refusing", () => {
    if (skip) return;
    const p = payload([PIE, { ...CUOTA_1, min_uf: 30.5 }, CUOTA_2], false);
    p.accepted = [{ label: "1", field: "min_uf", reason: "the bank's own figure was rounded" }];
    const r = applyMortgageSheetPayments(p);
    expect(r.status).toBe("applied");
    expect(r.details.drift).toEqual([]);
    expect(r.details.accepted).toEqual([{ label: "1", field: "min_uf", sheet: 30.5, ledger: 30, reason: "the bank's own figure was rounded" }]);
    expect(r.details.rows.map((x) => x.status)).toEqual(["checked", "checked", "written"]);
  });

  it("refuses a posted cuota whose split the app cannot reproduce", () => {
    if (skip) return;
    const r = applyMortgageSheetPayments(payload([PIE, CUOTA_1, { ...CUOTA_2, amortizacion_clp: 97_000, amortizacion_ext_clp: 359_000 }], true));
    expect(r.status).toBe("conflict");
    expect(r.details.drift.map((d) => d.field).sort()).toEqual(["amortizacion_clp", "amortizacion_ext_clp"]);
  });

  it("writes the posted cuota as the form would, fills max_uf, records the document, then answers duplicate", () => {
    if (skip) return;
    const before = movementCount();
    const r = applyMortgageSheetPayments(payload([PIE, CUOTA_1, CUOTA_2, CUOTA_3_FUTURE], true));
    expect(r.status).toBe("applied");
    expect(r.details.applied).toBe(true);
    expect(movementCount()).toBe(before + 2);
    const ledger = loadDeptoLedgerFromMovements();
    const c2 = ledger.find((x) => x.cuota === "2")!;
    expect(c2.occurred_on).toBe("1990-03-11");
    expect(c2.pago_clp).toBe(800_000);
    expect(c2.amortizacion_clp).toBe(96_000);
    expect(c2.amortizacion_ext_clp).toBe(360_000);
    expect(c2.credito_restante_uf).toBeCloseTo(2988.6, 4);
    expect(c2.min_uf).toBe(11);
    expect(c2.max_uf).toBe(80);
    const written = r.details.rows.find((x) => x.label === "2")!;
    expect(written.mortgage_movement_id).toBeGreaterThan(0);
    const mov = db.prepare(`SELECT note, flow_kind FROM movements WHERE id = ?`).get(written.mortgage_movement_id) as { note: string; flow_kind: string };
    expect(mov.note).toBe("Pago hipoteca — cuota 2");
    expect(mov.flow_kind).toBe("pago_cuota_hipotecario");
    expect((db.prepare(`SELECT origin FROM depto_payments WHERE movement_id = ?`).get(written.mortgage_movement_id) as { origin: string }).origin).toBe("import");
    expect(ledger.find((x) => x.cuota === "1")!.max_uf).toBe(80.5);

    const again = applyMortgageSheetPayments(payload([PIE, CUOTA_1, CUOTA_2, CUOTA_3_FUTURE], true));
    expect(again.status).toBe("duplicate");
    expect(movementCount()).toBe(before + 2);

    // A changed file with the same rows: everything checked, nothing written.
    const edited = applyMortgageSheetPayments(payload([PIE, CUOTA_1, CUOTA_2, CUOTA_3_FUTURE], true, "2".repeat(64)));
    expect(edited.status).toBe("applied");
    expect(edited.details.rows.map((x) => x.status)).toEqual(["checked", "checked", "checked", "not_due"]);
    expect(movementCount()).toBe(before + 2);
  });
});
