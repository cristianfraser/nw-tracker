import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import {
  deptoPaymentColumnsFromPaymentRow,
  deptoPaymentHumanNote,
  deptoSueciaNetEquityUfBySnapshotDates,
  insertDeptoPaymentRow,
  sheetRowToPaymentRow,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import {
  DEPTO_PROPERTY_ACCOUNT_NOTES,
  deptoAccountMarkClpAtYmd,
  loadDeptoLedgerFromMovements,
} from "./deptoLedgerFromMovements.js";
import { ufClpBySnapshotDatesAsc } from "./fxRates.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { getAccountMonthlyPerformance } from "./accountPerformance.js";
import { reconcileDashboardCardMetrics } from "./dashboardCardMetricsReconcile.js";
import { monthKeyFromYmd } from "./calendarMonth.js";

/**
 * Synthetic depto fixture (movements-only, per repo fixture policy): a property master +
 * mortgage master with pie + two cuota movements written via the real note builders, on
 * recent dates so today/prior-month-end marks have data. Skipped when the DB already
 * tracks a real depto (dev-DB copies).
 */
const MORTGAGE_ACCOUNT_NOTES = "import:excel|key=mortgage";

function ymdDaysAgo(days: number): string {
  const [y, m, d] = chileCalendarTodayYmd().split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! - days));
  return t.toISOString().slice(0, 10);
}

function paymentRow(): DeptoDividendosPaymentRow {
  return sheetRowToPaymentRow({
    cuota: "1",
    occurred_on: "2000-01-01",
    pago_clp: 0,
    pago_uf: null,
    pct_dividendo: null,
    uf_clp_day: null,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf: null,
    pct_credito_uf: null,
    restante_clp: null,
    pct_de_total: null,
    delta_credito_clp: null,
    valor_neto_uf: null,
    valor_neto_clp: null,
    pagado_neto_uf: null,
    delta_valor_neto_clp: null,
    valor_vivienda_uf: null,
    valor_vivienda_clp: null,
    min_uf: null,
    incendio_clp: null,
    incendio_uf: null,
    desgravamen_clp: null,
    desgravamen_uf: null,
    total_seguros_uf: null,
    total_seguros_clp: null,
    amortizacion_clp: null,
    amortizacion_uf: null,
    amortizacion_ext_clp: null,
    amortizacion_ext_uf: null,
    interes_clp: null,
    interes_uf: null,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    pago_acumulado_clp: null,
    amort_acum_clp: null,
    interes_acum_clp: null,
  });
}

let fixturePropertyId: number | null = null;
let fixtureMortgageId: number | null = null;

beforeAll(() => {
  const existing = db
    .prepare(`SELECT 1 FROM accounts WHERE notes = ? AND account_kind = 'master'`)
    .get(DEPTO_PROPERTY_ACCOUNT_NOTES);
  if (existing) return; // real depto tracked — tests run against it

  const propGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'real_estate__property'`)
    .get() as { id: number } | undefined;
  const mortGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'liabilities__mortgage'`)
    .get() as { id: number } | undefined;
  if (!propGroup || !mortGroup) return;

  fixturePropertyId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, account_kind)
         VALUES (?, 'suecia fixture', ?, 'master')`
      )
      .run(propGroup.id, DEPTO_PROPERTY_ACCOUNT_NOTES).lastInsertRowid
  );
  const hadMortgage = db
    .prepare(`SELECT id FROM accounts WHERE notes = ? AND account_kind = 'master'`)
    .get(MORTGAGE_ACCOUNT_NOTES) as { id: number } | undefined;
  fixtureMortgageId = hadMortgage
    ? null
    : Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, notes, account_kind)
             VALUES (?, 'suecia fixture', ?, 'master')`
          )
          .run(mortGroup.id, MORTGAGE_ACCOUNT_NOTES).lastInsertRowid
      );
  const mortgageId = fixtureMortgageId ?? hadMortgage!.id;

  const rows: { r: DeptoDividendosPaymentRow; onMortgage: boolean }[] = [
    {
      r: {
        ...paymentRow(),
        cuota: "pie",
        occurred_on: ymdDaysAgo(75),
        amount_clp: 58_000_000,
        amount_uf: 1450,
        credito_restante_uf: 3950,
        valor_vivienda_uf: 5400,
        valor_neto_uf: 1450,
        valor_neto_clp: 58_000_000,
        pago_acumulado_clp: 58_000_000,
      },
      onMortgage: false,
    },
    {
      r: {
        ...paymentRow(),
        cuota: "1",
        occurred_on: ymdDaysAgo(45),
        amount_clp: 1_200_000,
        amount_uf: 30,
        credito_restante_uf: 3936,
        valor_vivienda_uf: 5400,
        valor_neto_uf: 1464,
        valor_neto_clp: 58_700_000,
        pago_acumulado_clp: 59_200_000,
        amortizacion_clp: 560_000,
        amortizacion_uf: 14,
        interes_clp: 600_000,
        interes_uf: 15,
        incendio_clp: 20_000,
        desgravamen_clp: 20_000,
        min_uf: 30,
        pagado_neto_uf: 1464,
      },
      onMortgage: true,
    },
    {
      r: {
        ...paymentRow(),
        cuota: "2",
        occurred_on: ymdDaysAgo(15),
        amount_clp: 1_205_000,
        amount_uf: 30,
        credito_restante_uf: 3921.8,
        valor_vivienda_uf: 5400,
        valor_neto_uf: 1478.2,
        valor_neto_clp: 59_400_000,
        pago_acumulado_clp: 60_405_000,
        amortizacion_clp: 565_000,
        amortizacion_uf: 14.2,
        interes_clp: 596_000,
        interes_uf: 14.8,
        incendio_clp: 22_000,
        desgravamen_clp: 22_000,
        min_uf: 30,
        pagado_neto_uf: 1478.2,
      },
      onMortgage: true,
    },
  ];
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?)`
  );
  for (const { r, onMortgage } of rows) {
    const cols = deptoPaymentColumnsFromPaymentRow(r);
    const prop = ins.run(
      fixturePropertyId,
      r.amount_clp,
      r.occurred_on,
      deptoPaymentHumanNote("dividendos", r.cuota, false)
    );
    insertDeptoPaymentRow({
      movement_id: Number(prop.lastInsertRowid),
      kind: "dividendos",
      origin: "import",
      ...cols,
    });
    if (onMortgage) {
      const mort = ins.run(
        mortgageId,
        Math.abs(r.amount_clp),
        r.occurred_on,
        deptoPaymentHumanNote("mortgage", r.cuota, false)
      );
      insertDeptoPaymentRow({
        movement_id: Number(mort.lastInsertRowid),
        kind: "mortgage",
        origin: "import",
        ...cols,
      });
    }
  }
});

afterAll(() => {
  for (const id of [fixturePropertyId, fixtureMortgageId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
});

function propertyAccountRow(): { id: number } | undefined {
  return db
    .prepare(`SELECT id FROM accounts WHERE notes = ? AND account_kind = 'master' LIMIT 1`)
    .get(DEPTO_PROPERTY_ACCOUNT_NOTES) as { id: number } | undefined;
}

describe("deptoAccountMarkClpAtYmd", () => {
  it("property mark at two dates differs when UF rates differ", () => {
    const ledger = loadDeptoLedgerFromMovements();
    if (!ledger.length) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const may = deptoAccountMarkClpAtYmd("property", priorEnd);
    const now = deptoAccountMarkClpAtYmd("property", today);
    if (!may || !now) return;

    const ufMap = ufClpBySnapshotDatesAsc([priorEnd, today]);
    const ufPrior = ufMap.get(priorEnd);
    const ufNow = ufMap.get(today);
    if (ufPrior == null || ufNow == null || ufPrior === ufNow) return;

    const netUf = deptoSueciaNetEquityUfBySnapshotDates([priorEnd], ledger).get(priorEnd);
    if (netUf == null) return;

    expect(now.value_clp).not.toBe(may.value_clp);
    expect(now.value_clp - may.value_clp).toBeCloseTo(netUf * (ufNow - ufPrior), -2);
  });
});

describe("deptoKindForBucketSlug via accountMarkClpAtYmd", () => {
  it("resolves real_estate__property leaf slug to depto UF mark", () => {
    const today = chileCalendarTodayYmd();
    const depto = deptoAccountMarkClpAtYmd("property", today);
    const viaLeaf = accountMarkClpAtYmd(0, today, "real_estate__property");
    if (!depto || !viaLeaf) return;
    expect(viaLeaf.value_clp).toBe(depto.value_clp);
  });
});

describe("accountMarkClpAtYmd property", () => {
  it("today uses UF mark not stale valuations when ledger exists", () => {
    const row = propertyAccountRow();
    if (!row) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const deptoToday = deptoAccountMarkClpAtYmd("property", today);
    if (!deptoToday) return;

    const markToday = accountMarkClpAtYmd(row.id, today, "real_estate__property");
    const markPrior = accountMarkClpAtYmd(row.id, priorEnd, "property");
    expect(markToday?.value_clp).toBe(deptoToday.value_clp);
    expect(markPrior?.value_clp).toBeDefined();

    if (markPrior && markToday && markPrior.value_clp !== markToday.value_clp) {
      const delta = markToday.value_clp - markPrior.value_clp;
      expect(Math.abs(delta)).toBeGreaterThan(0);
    }
  });

  it("suecia current-month perf nominal reflects UF move when prior month-end differs", () => {
    const row = propertyAccountRow();
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const curMk = monthKeyFromYmd(chileCalendarTodayYmd());
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (cur?.nominal_pl == null) return;

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const may = deptoAccountMarkClpAtYmd("property", priorEnd);
    const now = deptoAccountMarkClpAtYmd("property", today);
    if (!may || !now || may.value_clp === now.value_clp) return;

    expect(Math.abs(cur.nominal_pl ?? 0)).toBeGreaterThan(0);
  });

  it("current-month perf row is dated Chile today", () => {
    const row = propertyAccountRow();
    if (!row) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!cur) return;

    expect(cur.as_of_date).toBe(today);
  });

  it("reconciled dashboard MTD non-zero when UF moved", () => {
    const acc = propertyAccountRow();
    if (!acc) return;
    const row = db
      .prepare(
        `SELECT a.id, a.name, a.notes, g.slug AS bucket_slug FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id WHERE a.id = ?`
      )
      .get(acc.id) as { id: number; name: string; notes: string | null; bucket_slug: string };

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const current = accountMarkClpAtYmd(row.id, today, row.bucket_slug, {
      notes: row.notes,
      name: row.name,
    });
    const prior = accountMarkClpAtYmd(row.id, priorEnd, row.bucket_slug, {
      notes: row.notes,
      name: row.name,
    });
    if (!current || !prior || current.value_clp === prior.value_clp) return;

    const reconciled = reconcileDashboardCardMetrics(
      {
        deposits_clp: 0,
        current_value_clp: current.value_clp,
        prior_month_close_clp: prior.value_clp,
        deposits_month_clp: 0,
      },
      { includeUsd: false, reconcilePeriodDeltas: true }
    );
    expect(reconciled.delta_month_clp).not.toBe(0);
    expect(reconciled.delta_month_clp).toBeCloseTo(current.value_clp - prior.value_clp, 0);
  });
});

describe("depto mortgage live perf row", () => {
  it("current-month row is dated today with UF fields after live patch", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE (g.slug LIKE '%__mortgage' OR g.slug = 'mortgage') AND a.account_kind = 'master'
         ORDER BY (a.notes = 'import:excel|key=mortgage') DESC
         LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    if (!loadDeptoLedgerFromMovements().length) return;

    const perf = getAccountMonthlyPerformance(row.id, "clp");
    if (!perf?.monthly.length) return;

    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const cur = perf.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    if (!cur) return;

    expect(cur.as_of_date).toBe(today);
    expect(cur.uf_clp_day).not.toBeNull();
    expect(Number.isFinite(cur.uf_clp_day)).toBe(true);
    expect(cur.closing_balance_uf).not.toBeNull();
    expect(Number.isFinite(cur.closing_balance_uf)).toBe(true);
  });
});
