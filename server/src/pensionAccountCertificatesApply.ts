import type {
  PensionAccountBalanceApplyDetails,
  PensionAccountBalancePayload,
  PensionAccountCertificatesApplyDetails,
  PensionAccountCertificatesPayload,
  PensionExpectedRow,
} from "nw-tracker-contracts";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpUnoSeries.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";
import {
  CONTRIBUTION_CODE,
  certificateRowPriceWindow,
  firstVisibleDayOfValue,
  pensionLedgerNote,
  shapePensionLedgerRows,
  type ShapedLedgerRow,
} from "./pensionLedgerShape.js";

/**
 * A pension account's two certificates (`pension_account.certificates`) against its cuota ledger.
 *
 * The ledger has the shape `pensionLedgerShape.ts` gives it: one row per day UNO's price became
 * visible in the account's series (`afp_uno_cuota_a`, the display frame), carrying every
 * certificate row bought or sold at that price, netted; a withdrawal is its own row. A row whose
 * valor cuota is not in the series yet is pending. Each contribution (110101) must also be on the
 * contributions certificate with the same pesos and cuotas.
 *
 * A row is present when the ledger has one on that day with those cuotas (each ledger row answers
 * one row). Missing rows are written when the read applies, and only when nothing disagrees: a
 * ledger row inside the certificate's window that it does not list, a present row whose pesos
 * differ, a withdrawal missing from the ledger (entered by hand), or a ledger total that would
 * not be the fund manager's stated balance all fail the read and write nothing.
 */

const AFP_ACCOUNT_IMPORT_KEY = "import:excel|key=afp";
const CUOTA_TOLERANCE = 0.005;
/**
 * The ledger carries cuotas to 4 decimals and the fund manager states its balance to 2, so a
 * total that is right equals the stated one at 4 decimals. A residue of 0,0002 cuotas is ~20
 * pesos at a 100.000 valor cuota — a row-matching tolerance would hide it.
 */
const BALANCE_TOLERANCE = 0.00005;

export type PensionLedgerRow = { id: number; occurred_on: string; amount: number; units_delta: number };
export type PensionSeriesRow = { day: string; unit_value_clp: number };

export type PensionPlan = {
  rows: PensionExpectedRow[];
  problems: string[];
  ledger_cuotas: number;
  ledger_cuotas_after: number;
};

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function expectedRow(r: ShapedLedgerRow): Omit<PensionExpectedRow, "state" | "movement_id" | "detail"> {
  return { period: r.periods.join(","), kind: r.kind, occurred_on: r.occurred_on, pesos: r.pesos, cuotas: r.cuotas };
}

/**
 * What the fund manager's website shows against what the app builds. The site states its balance
 * as cuotas × valor cuota = pesos; the app values the account at the day that valor cuota shows
 * in its own series. The two must agree to the peso (1 of rounding): a residue in the ledger's
 * cuotas, a price the app carries on another day, or a different price all show up here.
 * A valor cuota the app's series does not carry yet (the SP publishes late) is `waiting`, not a
 * problem: the next read compares it.
 */
export type PensionValueCheck = PensionAccountCertificatesApplyDetails["value_check"];

export const PENSION_VALUE_TOLERANCE_CLP = 1;
const VALUE_LOOKBACK_DAYS = 30;

export function checkPensionStatedValue(
  stated: { cuotas: number; valor_cuota: number; pesos: number },
  series: readonly PensionSeriesRow[],
  today: string,
  /** The app's value of the account on a day, including the rows this read would write. */
  appValueAt: (day: string) => number
): { check: PensionValueCheck; problems: string[] } {
  const problems: string[] = [];
  const siteProduct = stated.cuotas * stated.valor_cuota;
  if (Math.abs(siteProduct - stated.pesos) > PENSION_VALUE_TOLERANCE_CLP) {
    problems.push(
      `the website's own figures disagree: ${stated.cuotas} cuotas × ${stated.valor_cuota} = ${Math.round(siteProduct)}, it states ${stated.pesos} pesos`
    );
  }
  const day = firstVisibleDayOfValue(
    series,
    stated.valor_cuota,
    chileCalendarAddDays(today, -VALUE_LOOKBACK_DAYS),
    chileCalendarAddDays(today, 1)
  );
  if (day == null) {
    const last = series.at(-1);
    return {
      check: {
        status: "waiting",
        site_pesos: stated.pesos,
        site_valor_cuota: stated.valor_cuota,
        site_cuotas: stated.cuotas,
        app_day: null,
        app_pesos: null,
        diff_clp: null,
        detail: `valor cuota ${stated.valor_cuota} is not in the app's series yet (latest ${last?.unit_value_clp ?? "none"} on ${last?.day ?? "—"})`,
      },
      problems,
    };
  }
  const appPesos = appValueAt(day);
  const diff = appPesos - stated.pesos;
  const matches = Math.abs(diff) <= PENSION_VALUE_TOLERANCE_CLP;
  if (!matches) {
    problems.push(
      `the website states ${stated.pesos} pesos (${stated.cuotas} cuotas × ${stated.valor_cuota}); the app builds ${Math.round(appPesos)} on ${day}, the day that valor cuota shows (${diff > 0 ? "+" : ""}${Math.round(diff)})`
    );
  }
  return {
    check: {
      status: matches ? "match" : "mismatch",
      site_pesos: stated.pesos,
      site_valor_cuota: stated.valor_cuota,
      site_cuotas: stated.cuotas,
      app_day: day,
      app_pesos: Math.round(appPesos * 100) / 100,
      diff_clp: Math.round(diff * 100) / 100,
      detail: null,
    },
    problems,
  };
}

/** What the certificates call for, against the ledger. Pure: the caller reads the rows. */
export function planPensionCertificates(
  payload: PensionAccountCertificatesPayload,
  ledger: readonly PensionLedgerRow[],
  series: readonly PensionSeriesRow[]
): PensionPlan {
  const problems: string[] = [];

  for (const r of payload.movements.rows.filter((x) => x.code === CONTRIBUTION_CODE && x.cuotas > 0)) {
    const c = payload.contributions.rows.filter(
      (x) => x.period === r.period && x.pesos === r.pesos && Math.abs(x.cuotas - r.cuotas) < CUOTA_TOLERANCE
    );
    if (c.length !== 1) {
      problems.push(
        `período ${r.period}: the contribution of ${r.pesos} pesos (${r.cuotas} cuotas) is ${c.length === 0 ? "not on" : "twice on"} the contributions certificate`
      );
    }
  }

  const shaped = shapePensionLedgerRows(
    payload.movements.rows.map((r) => {
      const w = certificateRowPriceWindow(r.period);
      return { ...r, factor: 1, day: firstVisibleDayOfValue(series, r.valor_cuota, w.fromDay, w.beforeDay) };
    })
  );

  // Pair each row with an unused ledger row on its day with its cuotas.
  const used = new Set<number>();
  const out: PensionExpectedRow[] = [];
  for (const e of shaped.rows.map(expectedRow)) {
    const hit = ledger.find(
      (l) => !used.has(l.id) && l.occurred_on === e.occurred_on && Math.abs(l.units_delta - e.cuotas) < CUOTA_TOLERANCE
    );
    if (!hit) {
      if (e.kind === "withdrawal") {
        problems.push(`período ${e.period}: a withdrawal of ${-e.cuotas} cuotas on ${e.occurred_on} is not in the ledger — enter it by hand`);
        out.push({ ...e, state: "conflict", movement_id: null, detail: "withdrawal not in the ledger" });
      } else {
        out.push({ ...e, state: "new", movement_id: null, detail: null });
      }
      continue;
    }
    used.add(hit.id);
    if (Math.round(hit.amount) !== e.pesos) {
      const detail = `the ledger has ${hit.amount} pesos`;
      problems.push(`período ${e.period} ${e.kind} on ${e.occurred_on}: certificate ${e.pesos} pesos, ${detail} (movement ${hit.id})`);
      out.push({ ...e, state: "conflict", movement_id: hit.id, detail });
    } else {
      out.push({ ...e, state: "present", movement_id: hit.id, detail: null });
    }
  }
  for (const p of shaped.pending) {
    out.push({
      period: p.period,
      kind: p.code === CONTRIBUTION_CODE ? "contribution" : "adjustment",
      occurred_on: null,
      pesos: p.pesos,
      cuotas: p.cuotas,
      state: "pending",
      movement_id: null,
      detail: `valor cuota ${p.valor_cuota} not in the series yet`,
    });
  }

  // The certificate covers its window completely: a ledger row inside it that no row answers is
  // a disagreement (a hand-entered row on another day, or one the fund manager reversed).
  const windowStart = shaped.rows.map((e) => e.occurred_on).sort()[0];
  if (windowStart) {
    for (const l of ledger) {
      if (l.occurred_on >= windowStart && !used.has(l.id)) {
        problems.push(`movement ${l.id} (${l.occurred_on}, ${l.units_delta} cuotas) is inside the certificate's window but not on it`);
      }
    }
  }

  const pendingCount = shaped.pending.length;
  const ledgerCuotas = ledger.reduce((s, l) => s + l.units_delta, 0);
  const ledgerAfter = ledgerCuotas + out.filter((r) => r.state === "new").reduce((s, r) => s + r.cuotas, 0);
  if (pendingCount === 0 && Math.abs(ledgerAfter - payload.balance.cuotas) >= BALANCE_TOLERANCE) {
    problems.push(`the ledger would hold ${ledgerAfter.toFixed(4)} cuotas; the fund manager states ${payload.balance.cuotas.toFixed(4)}`);
  }
  out.sort((a, b) => (a.occurred_on ?? "9999").localeCompare(b.occurred_on ?? "9999"));
  return { rows: out, problems, ledger_cuotas: round4(ledgerCuotas), ledger_cuotas_after: round4(ledgerAfter) };
}

function afpAccountId(): number {
  const row = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(AFP_ACCOUNT_IMPORT_KEY) as { id: number } | undefined;
  if (!row) throw new Error(`pension: no account with import_key "${AFP_ACCOUNT_IMPORT_KEY}"`);
  return row.id;
}

function loadLedger(accountId: number): PensionLedgerRow[] {
  const legs = db
    .prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? OR to_account_id = ?`)
    .get(accountId, accountId) as { n: number };
  if (legs.n > 0) throw new Error(`pension: account ${accountId} has transfer legs — the certificate reconcile reads single-leg rows only`);
  return db
    .prepare(
      `SELECT id, occurred_on, amount, COALESCE(units_delta, 0) AS units_delta FROM movements
        WHERE account_id = ? AND currency = 'clp' ORDER BY occurred_on, id`
    )
    .all(accountId) as PensionLedgerRow[];
}

function loadSeries(fromPeriod: string): PensionSeriesRow[] {
  return db
    .prepare(`SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day >= ? ORDER BY day`)
    .all(AFP_UNO_CUOTA_SERIES_KEY, certificateRowPriceWindow(fromPeriod).fromDay) as PensionSeriesRow[];
}

export function applyPensionAccountCertificates(
  payload: PensionAccountCertificatesPayload,
  sourceRef: string
): PensionAccountCertificatesApplyDetails {
  if (payload.provider !== "afp_uno" || payload.product !== "mandatory") {
    throw new Error(`pension: no account mapped for ${payload.provider} ${payload.product}`);
  }
  const accountId = afpAccountId();
  const series = loadSeries(payload.movements.from_period);
  const plan = planPensionCertificates(payload, loadLedger(accountId), series);
  const fresh = plan.rows.filter((r) => r.state === "new");
  const value = checkPensionStatedValue(payload.balance, series, chileCalendarTodayYmd(), (day) => {
    const mark = accountMarkClpAtYmd(accountId, day)?.value_clp;
    if (mark == null) throw new Error(`pension: account ${accountId} has no value on ${day}`);
    const px = [...series].reverse().find((s) => s.day <= day)!.unit_value_clp;
    const freshCuotas = fresh.filter((r) => r.occurred_on! <= day).reduce((s, r) => s + r.cuotas, 0);
    return mark + freshCuotas * px;
  });
  plan.problems.push(...value.problems);
  const write = payload.apply && plan.problems.length === 0;
  let inserted = 0;
  db.transaction(() => {
    if (write) {
      const insert = db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, ?)`
      );
      for (const r of fresh) {
        const note = pensionLedgerNote({ kind: r.kind as ShapedLedgerRow["kind"], periods: r.period.split(","), occurred_on: r.occurred_on!, pesos: r.pesos, cuotas: r.cuotas });
        const res = insert.run(accountId, r.pesos, r.occurred_on, note, r.cuotas);
        r.movement_id = Number(res.lastInsertRowid);
        inserted += 1;
      }
    }
    db.prepare(
      `INSERT INTO pension_account_reads
         (provider, account_id, source_ref, read_at, received_at, applied, new_rows, inserted, pending, problems_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      payload.provider,
      accountId,
      sourceRef,
      payload.read_at,
      new Date().toISOString(),
      payload.apply ? 1 : 0,
      fresh.length,
      inserted,
      plan.rows.filter((r) => r.state === "pending").length,
      JSON.stringify(plan.problems)
    );
  })();
  if (inserted > 0) {
    invalidateAggregationForAccountDate(accountId, fresh.map((r) => r.occurred_on!).sort()[0]!);
  }
  return {
    applied: write,
    account_id: accountId,
    rows: plan.rows,
    inserted,
    balance: { stated_cuotas: payload.balance.cuotas, ledger_cuotas_after: plan.ledger_cuotas_after },
    value_check: value.check,
    pending: plan.rows.filter((r) => r.state === "pending").length,
    problems: plan.problems,
  };
}

/**
 * The nightly balance read (`pension_account.balance`). The stated cuotas against the ledger's
 * decide whether the certificates must be read: anything that moves cuotas — a contribution, a
 * commission, a withdrawal — changes them. With the cuotas equal, the stated pesos are checked
 * against the app's value (`checkPensionStatedValue`); a difference there is a price or framing
 * error the certificates cannot explain, so it fails the step.
 */
export function applyPensionAccountBalance(payload: PensionAccountBalancePayload): PensionAccountBalanceApplyDetails {
  if (payload.provider !== "afp_uno" || payload.product !== "mandatory") {
    throw new Error(`pension: no account mapped for ${payload.provider} ${payload.product}`);
  }
  const accountId = afpAccountId();
  const ledgerCuotas = round4(loadLedger(accountId).reduce((s, l) => s + l.units_delta, 0));
  const certificatesNeeded = Math.abs(ledgerCuotas - payload.balance.cuotas) >= BALANCE_TOLERANCE;
  if (certificatesNeeded) {
    return {
      account_id: accountId,
      stated_cuotas: payload.balance.cuotas,
      ledger_cuotas: ledgerCuotas,
      certificates_needed: true,
      value_check: null,
      problems: [],
    };
  }
  const today = chileCalendarTodayYmd();
  const series = db
    .prepare(`SELECT day, unit_value_clp FROM fund_unit_daily WHERE series_key = ? AND day >= ? ORDER BY day`)
    .all(AFP_UNO_CUOTA_SERIES_KEY, chileCalendarAddDays(today, -60)) as PensionSeriesRow[];
  const value = checkPensionStatedValue(payload.balance, series, today, (day) => {
    const mark = accountMarkClpAtYmd(accountId, day)?.value_clp;
    if (mark == null) throw new Error(`pension: account ${accountId} has no value on ${day}`);
    return mark;
  });
  return {
    account_id: accountId,
    stated_cuotas: payload.balance.cuotas,
    ledger_cuotas: ledgerCuotas,
    certificates_needed: false,
    value_check: value.check,
    problems: value.problems,
  };
}
