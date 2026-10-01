import type {
  PensionAccountCertificatesApplyDetails,
  PensionAccountCertificatesPayload,
  PensionExpectedRow,
  PensionMovement,
} from "nw-tracker-contracts";
import { AFP_UNO_CUOTA_SERIES_KEY } from "./afpQuetalmiApi.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { db } from "./db.js";

/**
 * A pension account's two certificates (`pension_account.certificates`) against its cuota ledger.
 *
 * The ledger keeps one row per contribution and per período's net adjustment, the shape the
 * 2026-07-10 rebuild gave it (PARSERS.md «AFP UNO certificates»):
 *
 * - a contribution (110101) on its fecha caja, from the contributions certificate (same período,
 *   pesos and cuotas);
 * - a contribution the unemployment insurance paid (111138), which the contributions certificate
 *   does not list, on the day the fund's valor cuota is the one the movements certificate prints
 *   (`fund_unit_daily`, within four months of the período) — pending while that day is not in
 *   the series;
 * - the período's other cuota-bearing rows netted into one adjustment (a commission's debit and
 *   its credit cancel; catch-up rentabilidad and reliquidaciones remain), on the período's fecha
 *   caja, else on its valor cuota's day;
 * - a withdrawal is never written here: it is entered by hand with the bank's date.
 *
 * A row is present when the ledger has one on that day with those cuotas (each ledger row answers
 * one row). Missing rows are written when the read applies, and only when nothing disagrees: a
 * ledger row inside the certificate's window that it does not list, a present row whose pesos
 * differ, a withdrawal, or a ledger total that would not be the fund manager's stated balance
 * all fail the read and write nothing.
 */

const AFP_ACCOUNT_IMPORT_KEY = "import:excel|key=afp";
const CONTRIBUTION_CODE = "110101";
const INSURANCE_CODE = "111138";
const WITHDRAWAL_CODES = new Set(["122774", "122776", "112777", "122974", "122976", "112977", "112877", "122874", "122876"]);
const CUOTA_TOLERANCE = 0.005;
const SERIES_MATCH_TOLERANCE_CLP = 0.005;
const SERIES_MATCH_MONTHS = 4;

export type PensionLedgerRow = { id: number; occurred_on: string; amount: number; units_delta: number };
export type PensionSeriesRow = { day: string; unit_value_clp: number };

export type PensionPlan = {
  rows: PensionExpectedRow[];
  problems: string[];
  ledger_cuotas: number;
  ledger_cuotas_after: number;
};

function addMonths(period: string, months: number): string {
  const [y, m] = period.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + months;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function signed(r: PensionMovement): number {
  return r.direction === "credit" ? r.cuotas : -r.cuotas;
}

function signedPesos(r: PensionMovement): number {
  return r.direction === "credit" ? r.pesos : -r.pesos;
}

/** The day the series printed this valor cuota, within the período's four months; null if none. */
function seriesDayFor(series: readonly PensionSeriesRow[], valor: number, period: string): string | null {
  const lo = `${period}-01`;
  const hi = `${addMonths(period, SERIES_MATCH_MONTHS)}-01`;
  const hits = series.filter((s) => s.day >= lo && s.day < hi && Math.abs(s.unit_value_clp - valor) <= SERIES_MATCH_TOLERANCE_CLP);
  if (hits.length > 1) {
    // Two days with the same valor cuota to the peso-cent: a real ambiguity, never a guess.
    throw new Error(`pension: valor cuota ${valor} printed on ${hits.map((h) => h.day).join(", ")} — cannot date the período ${period} row`);
  }
  return hits[0]?.day ?? null;
}

/** What the certificates call for, against the ledger. Pure: the caller reads the rows. */
export function planPensionCertificates(
  payload: PensionAccountCertificatesPayload,
  ledger: readonly PensionLedgerRow[],
  series: readonly PensionSeriesRow[]
): PensionPlan {
  const problems: string[] = [];
  const expected: Omit<PensionExpectedRow, "state" | "movement_id" | "detail">[] = [];
  const pendingRows: PensionExpectedRow[] = [];

  const periods = [...new Set(payload.movements.rows.map((r) => r.period))].sort();
  for (const period of periods) {
    const rows = payload.movements.rows.filter((r) => r.period === period);
    const cajaDays = payload.contributions.rows.filter((c) => c.period === period).map((c) => c.paid_on).sort();

    for (const r of rows.filter((x) => x.code === CONTRIBUTION_CODE && x.cuotas > 0)) {
      const c = payload.contributions.rows.filter((x) => x.period === period && x.pesos === r.pesos && Math.abs(x.cuotas - r.cuotas) < CUOTA_TOLERANCE);
      if (c.length !== 1) {
        problems.push(
          `período ${period}: the contribution of ${r.pesos} pesos (${r.cuotas} cuotas) is ${c.length === 0 ? "not on" : "twice on"} the contributions certificate`
        );
        continue;
      }
      expected.push({ period, kind: "contribution", occurred_on: c[0]!.paid_on, pesos: r.pesos, cuotas: r.cuotas });
    }
    for (const r of rows.filter((x) => x.code === INSURANCE_CODE && x.cuotas > 0)) {
      const day = seriesDayFor(series, r.valor_cuota, period);
      const row = { period, kind: "insurance_contribution", occurred_on: day, pesos: r.pesos, cuotas: signed(r) };
      if (day) expected.push(row);
      else pendingRows.push({ ...row, state: "pending", movement_id: null, detail: `valor cuota ${r.valor_cuota} not in the series yet` });
    }
    const withdrawals = rows.filter((x) => WITHDRAWAL_CODES.has(x.code) && x.cuotas > 0);
    if (withdrawals.length > 0) {
      problems.push(`período ${period}: a withdrawal (${withdrawals.map((w) => w.description).join(", ")}) — enter it by hand with the bank's date`);
      continue;
    }
    const other = rows.filter((x) => x.code !== CONTRIBUTION_CODE && x.code !== INSURANCE_CODE);
    const net = round2(other.reduce((s, r) => s + signed(r), 0));
    if (Math.abs(net) >= CUOTA_TOLERANCE) {
      const pesos = other.filter((r) => r.cuotas > 0).reduce((s, r) => s + signedPesos(r), 0);
      const day = cajaDays[0] ?? seriesDayFor(series, other.find((r) => r.cuotas > 0)!.valor_cuota, period);
      const row = { period, kind: "adjustment", occurred_on: day, pesos, cuotas: net };
      if (day) expected.push(row);
      else pendingRows.push({ ...row, state: "pending", movement_id: null, detail: "no fecha caja and its valor cuota is not in the series yet" });
    }
  }

  // Pair each row with an unused ledger row on its day with its cuotas.
  const used = new Set<number>();
  const out: PensionExpectedRow[] = [];
  for (const e of expected) {
    const hit = ledger.find((l) => !used.has(l.id) && l.occurred_on === e.occurred_on && Math.abs(l.units_delta - e.cuotas) < CUOTA_TOLERANCE);
    if (!hit) {
      out.push({ ...e, state: "new", movement_id: null, detail: null });
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
  out.push(...pendingRows);

  // The certificate covers its window completely: a ledger row inside it that no row answers is
  // a disagreement (a hand-entered row on another day, or one the fund manager reversed).
  const windowStart = expected.map((e) => e.occurred_on!).sort()[0];
  if (windowStart) {
    for (const l of ledger) {
      if (l.occurred_on >= windowStart && !used.has(l.id)) {
        problems.push(`movement ${l.id} (${l.occurred_on}, ${l.units_delta} cuotas) is inside the certificate's window but not on it`);
      }
    }
  }

  const ledgerCuotas = ledger.reduce((s, l) => s + l.units_delta, 0);
  const ledgerAfter = ledgerCuotas + out.filter((r) => r.state === "new").reduce((s, r) => s + r.cuotas, 0);
  if (pendingRows.length === 0 && Math.abs(ledgerAfter - payload.balance.cuotas) >= CUOTA_TOLERANCE) {
    problems.push(`the ledger would hold ${ledgerAfter.toFixed(2)} cuotas; the fund manager states ${payload.balance.cuotas.toFixed(2)}`);
  }
  out.sort((a, b) => (a.occurred_on ?? "9999").localeCompare(b.occurred_on ?? "9999"));
  return { rows: out, problems, ledger_cuotas: round2(ledgerCuotas), ledger_cuotas_after: round2(ledgerAfter) };
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
    .all(AFP_UNO_CUOTA_SERIES_KEY, `${fromPeriod}-01`) as PensionSeriesRow[];
}

function noteFor(r: PensionExpectedRow): string {
  if (r.kind === "contribution") return `AFP cotización — período ${r.period} (caja ${r.occurred_on})`;
  if (r.kind === "insurance_contribution") return `AFP abono AFC/SLP — período ${r.period}`;
  return `AFP reliquidaciones/comisiones netas — período ${r.period}`;
}

export function applyPensionAccountCertificates(
  payload: PensionAccountCertificatesPayload,
  sourceRef: string
): PensionAccountCertificatesApplyDetails {
  if (payload.provider !== "afp_uno" || payload.product !== "mandatory") {
    throw new Error(`pension: no account mapped for ${payload.provider} ${payload.product}`);
  }
  const accountId = afpAccountId();
  const plan = planPensionCertificates(payload, loadLedger(accountId), loadSeries(payload.movements.from_period));
  const fresh = plan.rows.filter((r) => r.state === "new");
  const write = payload.apply && plan.problems.length === 0;
  let inserted = 0;
  db.transaction(() => {
    if (write) {
      const insert = db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta) VALUES (?, ?, 'clp', ?, ?, ?)`
      );
      for (const r of fresh) {
        const res = insert.run(accountId, r.pesos, r.occurred_on, noteFor(r), r.cuotas);
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
    pending: plan.rows.filter((r) => r.state === "pending").length,
    problems: plan.problems,
  };
}

/** The latest read that wrote new rows with nothing to fix, as its ISO instant. */
export function lastCleanPensionImportAt(provider: "afp_uno"): string | null {
  const row = db
    .prepare(
      `SELECT MAX(read_at) AS at FROM pension_account_reads
        WHERE provider = ? AND applied = 1 AND inserted > 0 AND pending = 0 AND problems_json = '[]'`
    )
    .get(provider) as { at: string | null };
  return row.at;
}
