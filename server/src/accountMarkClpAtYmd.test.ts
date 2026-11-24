import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import {
  deptoPaymentHumanNote,
  deptoNetEquityUfBySnapshotDates,
  insertLoanPaymentRow,
  loanPaymentColumnsFromPaymentRow,
  mortgageSheetPaymentEventsThroughDate,
  upsertPropertyAppraisalUf,
  type DeptoDividendosPaymentRow,
} from "./deptoDividendosLedger.js";
import { buildDashboardAccountRows } from "./dashboardAccounts.js";
import { withPortfolioGroupIndex } from "./portfolioGroupTree.js";
import {
  DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY,
  deptoAccountMarkClpAtYmd,
  loadAllDeptoLedgers,
} from "./deptoLedgerFromMovements.js";
import { storedPairRatesOnOrBefore } from "./rates.js";
import { priorPeriodEndYmd } from "./accountPeriodMarks.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { monthlyPerfForAccountId } from "./groupMonthlyPerfConsolidation.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { accountWithRoleOptional } from "./accountRoles.js";
/** The depto property and its loan (their roles). */
const deptoPropertyId = (): number => accountWithRoleOptional("property") ?? -1;


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
  return {
    cuota: "1",
    occurred_on: "2000-01-01",
    amount_clp: 0,
    credito_restante_uf: null,
    min_uf: null,
    max_uf: null,
    amortizacion_clp: null,
    amortizacion_ext_clp: null,
    interes_clp: null,
    incendio_clp: null,
    desgravamen_clp: null,
  };
}

let fixturePropertyId: number | null = null;
let fixtureMortgageId: number | null = null;

beforeAll(() => {
  // The Vitest person rents: it tracks no depto and no mortgage, so this file's fixture is
  // the only property/loan pair and every test below runs against it.
  const existing = db
    .prepare(`SELECT 1 FROM accounts WHERE import_key IN (?, ?)`)
    .get(DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, MORTGAGE_ACCOUNT_NOTES);
  if (existing) throw new Error("test DB already tracks a depto; the fixture expects none");

  const propGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'real_estate__property'`)
    .get() as { id: number } | undefined;
  const mortGroup = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'liabilities__mortgage'`)
    .get() as { id: number } | undefined;
  if (!propGroup || !mortGroup) throw new Error("property / mortgage asset groups missing");

  fixturePropertyId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'depto fixture', ?, ?)`
      )
      .run(propGroup.id, DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY, DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY).lastInsertRowid
  );
  fixtureMortgageId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'depto fixture', ?, ?)`
      )
      .run(mortGroup.id, MORTGAGE_ACCOUNT_NOTES, MORTGAGE_ACCOUNT_NOTES).lastInsertRowid
  );
  const mortgageId = fixtureMortgageId;

  const rows: { r: DeptoDividendosPaymentRow; onMortgage: boolean }[] = [
    {
      r: {
        ...paymentRow(),
        cuota: "pie",
        occurred_on: ymdDaysAgo(75),
        amount_clp: 58_000_000,
        credito_restante_uf: 3950,
      },
      onMortgage: false,
    },
    {
      r: {
        ...paymentRow(),
        cuota: "1",
        occurred_on: ymdDaysAgo(45),
        amount_clp: 1_200_000,
        credito_restante_uf: 3936,
        amortizacion_clp: 560_000,
        interes_clp: 600_000,
        incendio_clp: 20_000,
        desgravamen_clp: 20_000,
        min_uf: 30,
      },
      onMortgage: true,
    },
    {
      r: {
        ...paymentRow(),
        cuota: "2",
        occurred_on: ymdDaysAgo(15),
        amount_clp: 1_205_000,
        credito_restante_uf: 3921.8,
        amortizacion_clp: 565_000,
        interes_clp: 596_000,
        incendio_clp: 22_000,
        desgravamen_clp: 22_000,
        min_uf: 30,
      },
      onMortgage: true,
    },
  ];
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
  );
  for (const { r, onMortgage } of rows) {
    const cols = loanPaymentColumnsFromPaymentRow(r);
    const prop = ins.run(
      fixturePropertyId,
      r.amount_clp,
      r.occurred_on,
      deptoPaymentHumanNote("property", r.cuota, false)
    );
    if (r.cuota === "pie") upsertPropertyAppraisalUf(fixturePropertyId!, r.occurred_on, 5400);
    insertLoanPaymentRow({
      movement_id: Number(prop.lastInsertRowid),
      loan_account_id: mortgageId,
      leg: "property",
      origin: "import",
      ...cols,
    });
    if (onMortgage) {
      const mort = ins.run(
        mortgageId,
        Math.abs(r.amount_clp),
        r.occurred_on,
        deptoPaymentHumanNote("loan", r.cuota, false)
      );
      insertLoanPaymentRow({
        movement_id: Number(mort.lastInsertRowid),
        loan_account_id: mortgageId,
        leg: "loan",
        origin: "import",
        ...cols,
      });
    }
  }

  // Month-end snapshots so the mortgage perf series has rows (closes themselves are
  // recomputed from the UF ledger; stored values only anchor snapshot dates).
  {
    const today = chileCalendarTodayYmd();
    const monthEnds = new Set<string>();
    for (const { r } of rows) {
      const [y, m] = r.occurred_on.split("-").map(Number);
      const me = new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
      if (me <= today) monthEnds.add(me);
    }
    const insVal = db.prepare(
      `INSERT OR IGNORE INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`
    );
    for (const me of monthEnds) insVal.run(fixtureMortgageId, me, 150_000_000);
  }
});

afterAll(() => {
  for (const id of [fixturePropertyId, fixtureMortgageId]) {
    if (id == null) continue;
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
});

function propertyAccountRow(): { id: number } | undefined {
  return db
    .prepare(`SELECT id FROM accounts WHERE import_key = ? LIMIT 1`)
    .get(DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY) as { id: number } | undefined;
}


/** The fixture property's account id (asserted to exist: the Vitest person has no depto). */
function fixtureProperty(): number {
  const row = propertyAccountRow();
  expect(row).toBeDefined();
  expect(deptoPropertyId()).toBe(row!.id);
  return row!.id;
}

/** UF at the prior month-end and today; the synthetic market moves the UF every day. */
function ufPriorAndToday(): { priorEnd: string; today: string; ufPrior: number; ufNow: number } {
  const today = chileCalendarTodayYmd();
  const priorEnd = priorPeriodEndYmd("mtd", today);
  const uf = storedPairRatesOnOrBefore("uf", "clp", [priorEnd, today]);
  const ufPrior = uf.get(priorEnd)!;
  const ufNow = uf.get(today)!;
  expect(ufPrior).toBeGreaterThan(0);
  expect(ufNow).toBeGreaterThan(0);
  expect(ufNow).not.toBe(ufPrior);
  return { priorEnd, today, ufPrior, ufNow };
}

describe("deptoAccountMarkClpAtYmd", () => {
  it("property mark at two dates differs when UF rates differ", () => {
    const propertyId = fixtureProperty();
    const ledger = loadAllDeptoLedgers().flatMap((l) => l.rows);
    // pie + two cuotas, each a property leg; the cuotas also carry a loan leg.
    expect(ledger.length).toBeGreaterThanOrEqual(3);

    const { priorEnd, today, ufPrior, ufNow } = ufPriorAndToday();
    const may = deptoAccountMarkClpAtYmd(propertyId, priorEnd);
    const now = deptoAccountMarkClpAtYmd(propertyId, today);
    expect(may).not.toBeNull();
    expect(now).not.toBeNull();

    const netMap = deptoNetEquityUfBySnapshotDates([priorEnd, today], ledger);
    const netPrior = netMap.get(priorEnd)!;
    const netNow = netMap.get(today)!;
    expect(netPrior).toBeGreaterThan(0);
    expect(netNow).toBeGreaterThan(0);

    expect(now!.value_clp).not.toBe(may!.value_clp);
    // Mark identity: value(d) = netEquityUf(d) × uf(d). Net equity can change inside the
    // window (a cuota paid after the prior month-end adds amortización equity), so each
    // date uses its own net UF — a single shared netUf made this calendar-date dependent.
    expect(may!.value_clp).toBeCloseTo(netPrior * ufPrior, 0);
    expect(now!.value_clp).toBeCloseTo(netNow * ufNow, 0);
    expect(now!.value_clp - may!.value_clp).toBeCloseTo(netNow * ufNow - netPrior * ufPrior, -2);
  });
});

describe("accountMarkClpAtYmd property", () => {
  it("today uses UF mark not stale valuations when ledger exists", () => {
    const propertyId = fixtureProperty();
    const { priorEnd, today } = ufPriorAndToday();
    const deptoToday = deptoAccountMarkClpAtYmd(propertyId, today);
    expect(deptoToday).not.toBeNull();

    const markToday = accountMarkClpAtYmd(propertyId, today);
    const markPrior = accountMarkClpAtYmd(propertyId, priorEnd);
    expect(markToday?.value_clp).toBe(deptoToday!.value_clp);
    expect(markPrior?.value_clp).toBe(deptoAccountMarkClpAtYmd(propertyId, priorEnd)!.value_clp);
  });

  it("depto current-month perf nominal reflects UF move when prior month-end differs", () => {
    const propertyId = fixtureProperty();
    const { priorEnd, today } = ufPriorAndToday();
    const may = deptoAccountMarkClpAtYmd(propertyId, priorEnd)!;
    const now = deptoAccountMarkClpAtYmd(propertyId, today)!;
    expect(now.value_clp).not.toBe(may.value_clp);

    const perf = monthlyPerfForAccountId(propertyId, "clp");
    const curMk = monthKeyFromYmd(today);
    const cur = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    expect(cur).toBeDefined();
    expect(cur!.nominal_pl).not.toBeNull();
    expect(cur!.prior_closing).not.toBeNull();

    // The month's row runs from the prior month-end's mark to today's mark: its P/L is the
    // level move less the month's payments, and the UF move makes it non-zero.
    expect(cur!.prior_closing!).toBeCloseTo(may.value_clp, 0);
    expect(cur!.closing_value).toBeCloseTo(now.value_clp, 0);
    expect(cur!.nominal_pl!).toBeCloseTo(
      cur!.closing_value - cur!.prior_closing! - cur!.net_capital_flow,
      2
    );
    expect(Math.abs(cur!.nominal_pl!)).toBeGreaterThan(0);
  });

  it("current-month perf row is dated Chile today", () => {
    const propertyId = fixtureProperty();
    const perf = monthlyPerfForAccountId(propertyId, "clp");
    expect(perf?.monthly.length).toBeGreaterThan(0);

    const today = chileCalendarTodayYmd();
    const curMk = monthKeyFromYmd(today);
    const cur = perf!.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    expect(cur).toBeDefined();
    expect(cur!.as_of_date).toBe(today);
  });

  it("property marks move with the UF between the month-end and today", () => {
    // The Vitest person tracks no depto, so the file's fixture property is always there.
    const acc = propertyAccountRow();
    expect(acc).toBeDefined();

    const today = chileCalendarTodayYmd();
    const priorEnd = priorPeriodEndYmd("mtd", today);
    const current = accountMarkClpAtYmd(acc!.id, today);
    const prior = accountMarkClpAtYmd(acc!.id, priorEnd);
    expect(current?.as_of_date).toBe(today);
    expect(prior).not.toBeNull();

    const uf = storedPairRatesOnOrBefore("uf", "clp", [priorEnd, today]);
    const ufPrior = uf.get(priorEnd)!;
    const ufNow = uf.get(today)!;
    expect(ufPrior).toBeGreaterThan(0);
    expect(ufNow).not.toBe(ufPrior);

    // The marks the dashboard row's prior-close fields carry: each date's mark is the
    // property's net equity in UF at that date × that date's UF, so a UF move between the
    // month-end and today moves the mark.
    const net = deptoNetEquityUfBySnapshotDates(
      [priorEnd, today],
      loadAllDeptoLedgers().flatMap((l) => l.rows)
    );
    expect(net.get(priorEnd)).toBeGreaterThan(0);
    expect(current!.value_clp).toBeCloseTo(net.get(today)! * ufNow, 0);
    expect(prior!.value_clp).toBeCloseTo(net.get(priorEnd)! * ufPrior, 0);
    expect(current!.value_clp).not.toBe(prior!.value_clp);
  });
});

/** The fixture mortgage's account id (the only mortgage: the Vitest person has none). */
function fixtureMortgage(): number {
  expect(fixtureMortgageId).not.toBeNull();
  const rows = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (g.slug LIKE '%__mortgage' OR g.slug = 'mortgage')`
    )
    .all() as { id: number }[];
  expect(rows.map((r) => r.id)).toEqual([fixtureMortgageId]);
  return fixtureMortgageId!;
}

describe("depto mortgage live perf row", () => {
  it("current-month row is dated today with UF fields after live patch", () => {
    const mortgageId = fixtureMortgage();
    const { today, ufNow } = ufPriorAndToday();

    const perf = monthlyPerfForAccountId(mortgageId, "clp");
    const curMk = monthKeyFromYmd(today);
    const cur = perf?.monthly.find((r) => monthKeyFromYmd(r.as_of_date) === curMk);
    expect(cur).toBeDefined();

    expect(cur!.as_of_date).toBe(today);
    expect(cur!.uf_clp_day).toBe(ufNow);
    // The fixture's last cuota leaves 3921,8 UF owed; today's balance is that or less.
    expect(cur!.closing_balance_uf).not.toBeNull();
    expect(cur!.closing_balance_uf!).toBeGreaterThan(0);
    expect(cur!.closing_balance_uf!).toBeLessThanOrEqual(3936);
  });
});

describe("mortgage P/L sign convention", () => {
  it("nominal_pl = prior − close − payments on every row; lifetime P/L is a loss", () => {
    const mortgageId = fixtureMortgage();
    const perf = monthlyPerfForAccountId(mortgageId, "clp");
    expect(perf?.monthly.length).toBeGreaterThan(0);

    let checked = 0;
    let sawPaymentMonth = false;
    for (const r of perf!.monthly) {
      if (r.prior_closing == null || r.nominal_pl == null) continue;
      checked += 1;
      expect(r.nominal_pl).toBeCloseTo(
        r.prior_closing - r.closing_value - r.net_capital_flow,
        2
      );
      if (r.net_capital_flow > 0) sawPaymentMonth = true;
    }
    expect(checked).toBeGreaterThan(0);
    expect(sawPaymentMonth).toBe(true);

    const cum = perf!.monthly[0]?.cumulative_nominal_pl;
    expect(cum).not.toBeNull();
    expect(cum!).toBeLessThan(0);
  });
});

describe("mortgage dashboard card metrics", () => {
  it("deposits = ledger payments and deltas = perf financing-cost P/L (not balance − deposits)", async () => {
    const mortgageId = fixtureMortgage();
    const ledger = loadAllDeptoLedgers().flatMap((l) => l.rows);

    const today = chileCalendarTodayYmd();
    const events = mortgageSheetPaymentEventsThroughDate(ledger, today);
    const expectedDeposits = events.reduce((s, e) => s + e.pago_clp, 0);
    // The fixture's two cuotas (1.200.000 + 1.205.000) are the loan's payments.
    expect(expectedDeposits).toBe(2_405_000);
    const priorMonthEnd = priorPeriodEndYmd("mtd", today);
    const expectedMonthDeposits = events
      .filter((e) => e.occurred_on > priorMonthEnd)
      .reduce((s, e) => s + e.pago_clp, 0);

    const perf = monthlyPerfForAccountId(mortgageId, "clp");
    const cum = perf?.monthly[0]?.cumulative_nominal_pl ?? null;
    expect(cum).not.toBeNull();

    const rows = await withPortfolioGroupIndex(async () => buildDashboardAccountRows("clp"));
    const dash = rows.find((r) => r.account_id === mortgageId);
    expect(dash).toBeDefined();
    expect(dash!.deposits).toBe(expectedDeposits);
    expect(dash!.deposits_month).toBe(expectedMonthDeposits);
    // Day metrics: mortgage is UF-marked (reprices every calendar day) — the day window
    // anchors on yesterday and the delta keeps the loss-negative convention
    // (prior − close − payments). Regression: v1 shipped mortgage day deltas as null.
    expect(dash!.prior_day_close).not.toBeNull();
    expect(dash!.current_value).not.toBeNull();
    expect(dash!.delta_day).not.toBeNull();
    expect(dash!.delta_day!).toBeCloseTo(
      dash!.prior_day_close! - dash!.current_value! - (dash!.deposits_day ?? 0),
      2
    );
    // Lifetime delta is the perf series' cumulative financing-cost P/L, never balance − deposits.
    expect(dash!.delta_total).toBeCloseTo(cum!, 2);
    expect(dash!.delta_total!).toBeLessThan(0);
  });
});
