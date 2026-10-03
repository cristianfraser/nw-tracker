/**
 * AFC (Fondo de Cesantía, Cuenta Individual) documents → the account's cuota ledger
 * (`unemployment_fund.documents`; ingest's `afc/documents.ts` reads the PDFs).
 *
 * Two documents from the AFC sucursal virtual:
 *
 * 1. **Certificado de cotizaciones previsionales acreditadas** — every cotización with período,
 *    empleador, renta imponible, monto and the exact **fecha de pago**, two legs per período
 *    (Cotiz. Trabajador 0,6 % + Cotiz. Empleador 1,6 %), closed by a `TOTAL` line. No cuotas are
 *    printed anywhere, and none are needed: the cuatrimestral cartola proves the AFC values the
 *    CIC at the Superintendencia's valor cuota (`afc_cic`) and credits each cotización at the
 *    valor cuota of its pay date (2026-09-22 calibration: 35 pesos off the cartola's printed
 *    comisiones over Jan–Apr 2026). So cuotas = monto ÷ valor cuota(fecha de pago), and the two
 *    legs of a período collapse into ONE movement dated the pay date.
 *
 * 2. **Estado cuatrimestral** (cartola) — saldo inicial / final with their dates, the period's
 *    cotizaciones (by MES DE PAGO), ganancia, comisiones and the printed identity
 *    `final = inicial + ingresos − egresos`. The AFC deducts its commission in cuotas, which the
 *    SP series does not carry, so each printed saldo is evidence of the cuota count on that day:
 *    a **true-up** movement per boundary (`cash_fee` when the ledger is above the saldo — the
 *    commission — `savings_earnings` when below) lands the ledger exactly on it. Both flow kinds
 *    are P/L to every deposit reader, never personal capital.
 *
 * Identity is the note key (`AFC cotización — período YYYY-MM (pago YYYY-MM-DD)`,
 * `AFC ajuste cartola — saldo inicial|final YYYY-MM-DD`), the same convention the bank importers
 * use; re-imports are idempotent and a changed printed amount is reported as a mismatch, never
 * overwritten. Report-first: `planAfcCertImport` / `planAfcCartolaTrueUps` compute, `apply…`
 * write.
 */
import type { UnemploymentFundDocumentsApplyDetails, UnemploymentFundDocumentsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { AFC_CIC_SERIES_KEY } from "./afcCicSeries.js";
import { afpCuotasCumulativeThroughDate } from "./afpUnoValuation.js";
import { fundUnitClpOnOrBefore } from "./fundUnitDaily.js";

// ---------------------------------------------------------------------------------------------
// Certificado de cotizaciones
// ---------------------------------------------------------------------------------------------

export type AfcCotizacionLeg = {
  /** `YYYY-MM` período the cotización belongs to. */
  period_ym: string;
  employer_rut: string;
  /** May be empty when the layout wrapped the name onto its own lines. */
  employer: string;
  renta_imponible_clp: number;
  amount_clp: number;
  /** Fecha de pago — the day the AFC credits the cuotas. */
  pay_ymd: string;
};

export type AfcCotizacionesCertificate = {
  legs: AfcCotizacionLeg[];
  total_clp: number;
};

export type AfcContribution = {
  period_ym: string;
  pay_ymd: string;
  amount_clp: number;
  employer: string;
  legs: AfcCotizacionLeg[];
};

/** One contribution per (período, fecha de pago): the trabajador + empleador legs collapse. */
export function groupAfcContributions(legs: readonly AfcCotizacionLeg[]): AfcContribution[] {
  const byKey = new Map<string, AfcContribution>();
  for (const l of legs) {
    const key = `${l.period_ym}|${l.pay_ymd}`;
    let c = byKey.get(key);
    if (!c) {
      c = { period_ym: l.period_ym, pay_ymd: l.pay_ymd, amount_clp: 0, employer: "", legs: [] };
      byKey.set(key, c);
    }
    c.amount_clp += l.amount_clp;
    c.legs.push(l);
    if (!c.employer && l.employer) c.employer = l.employer;
  }
  return [...byKey.values()].sort((a, b) => a.pay_ymd.localeCompare(b.pay_ymd) || a.period_ym.localeCompare(b.period_ym));
}

export function afcContributionNoteKey(period_ym: string, pay_ymd: string): string {
  return `AFC cotización — período ${period_ym} (pago ${pay_ymd})`;
}

function afcContributionNote(c: AfcContribution): string {
  const legs = c.legs.map((l) => `${l.amount_clp}`).join(" + ");
  const employer = c.employer ? ` · ${c.employer}` : "";
  return `${afcContributionNoteKey(c.period_ym, c.pay_ymd)}${employer} · legs ${legs}`;
}

const EXCEL_AFC_FLOW_NOTE_PREFIX = "import:excel|afc-flow";

export type AfcMovementRow = {
  id: number;
  occurred_on: string;
  amount: number;
  currency: string;
  units_delta: number | null;
  flow_kind: string | null;
  note: string | null;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
};

function listAccountMovements(accountId: number): AfcMovementRow[] {
  return db
    .prepare(
      `SELECT id, occurred_on, amount, currency, units_delta, flow_kind, note, account_id, from_account_id, to_account_id
       FROM movements
       WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
       ORDER BY date(occurred_on), id`
    )
    .all(accountId, accountId, accountId) as AfcMovementRow[];
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function requirePx(seriesKey: string, dayYmd: string): number {
  const px = fundUnitClpOnOrBefore(seriesKey, dayYmd);
  if (px == null) throw new Error(`afc: no ${seriesKey} valor cuota on or before ${dayYmd} — run backfill:afc-cic`);
  return px;
}

export type AfcCertPlanItem = {
  contribution: AfcContribution;
  px: number;
  units: number;
  status: "insert" | "unchanged" | "update_units" | "mismatch";
  existing_id: number | null;
  detail?: string;
};

export type AfcCertPlan = {
  account_id: number;
  series_key: string;
  items: AfcCertPlanItem[];
  /** Excel-era contribution rows (`import:excel|afc-flow`, amount > 0) the certificate supersedes. */
  excel_contribution_rows: AfcMovementRow[];
  /** Other excel-era rows (withdrawals / corrections) — kept unless explicitly dropped. */
  excel_other_rows: AfcMovementRow[];
};

export function planAfcCertImport(accountId: number, cert: AfcCotizacionesCertificate): AfcCertPlan {
  const seriesKey = requireAfcSeriesKey(accountId);
  const existing = listAccountMovements(accountId);
  const singleLeg = existing.filter((m) => m.account_id === accountId);
  const items: AfcCertPlanItem[] = [];
  for (const c of groupAfcContributions(cert.legs)) {
    const px = requirePx(seriesKey, c.pay_ymd);
    const units = round4(c.amount_clp / px);
    const key = afcContributionNoteKey(c.period_ym, c.pay_ymd);
    const match = singleLeg.filter((m) => (m.note ?? "").startsWith(key));
    if (match.length > 1) throw new Error(`afc: ${match.length} movements carry the key «${key}»`);
    const m = match[0];
    if (!m) {
      items.push({ contribution: c, px, units, status: "insert", existing_id: null });
    } else if (Math.round(m.amount) !== c.amount_clp || m.currency !== "clp" || m.occurred_on !== c.pay_ymd) {
      items.push({
        contribution: c,
        px,
        units,
        status: "mismatch",
        existing_id: m.id,
        detail: `stored ${m.amount} ${m.currency} on ${m.occurred_on}`,
      });
    } else if (m.units_delta == null || Math.abs(m.units_delta - units) > 0.00005) {
      items.push({ contribution: c, px, units, status: "update_units", existing_id: m.id, detail: `stored units ${m.units_delta ?? "—"}` });
    } else {
      items.push({ contribution: c, px, units, status: "unchanged", existing_id: m.id });
    }
  }
  const excelRows = singleLeg.filter((m) => (m.note ?? "").startsWith(EXCEL_AFC_FLOW_NOTE_PREFIX));
  return {
    account_id: accountId,
    series_key: seriesKey,
    items,
    excel_contribution_rows: excelRows.filter((m) => m.amount > 0),
    excel_other_rows: excelRows.filter((m) => m.amount <= 0),
  };
}

function requireAfcSeriesKey(accountId: number): string {
  const row = db.prepare(`SELECT fund_series_key FROM accounts WHERE id = ?`).get(accountId) as
    | { fund_series_key: string | null }
    | undefined;
  if (!row) throw new Error(`afc: unknown account ${accountId}`);
  if (row.fund_series_key !== AFC_CIC_SERIES_KEY) {
    throw new Error(`afc: account ${accountId} has fund_series_key=${row.fund_series_key ?? "NULL"}, expected ${AFC_CIC_SERIES_KEY}`);
  }
  return AFC_CIC_SERIES_KEY;
}

const stmtInsertContribution = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
   VALUES (?, ?, 'clp', ?, ?, ?)`
);
const stmtUpdateUnits = db.prepare(`UPDATE movements SET units_delta = ? WHERE id = ?`);
const stmtDeleteMovement = db.prepare(`DELETE FROM movements WHERE id = ?`);

export type AfcCertApplyResult = { inserted: number; units_updated: number; deleted: number; mismatches: number };

/**
 * Write the plan: insert / update-units the certificate contributions, delete the superseded
 * excel contribution rows when asked, plus any explicitly listed extra ids. Mismatches are never
 * written. One transaction.
 */
export function applyAfcCertImport(
  plan: AfcCertPlan,
  opts: { replaceExcelContributions: boolean; dropIds?: readonly number[] }
): AfcCertApplyResult {
  const out: AfcCertApplyResult = { inserted: 0, units_updated: 0, deleted: 0, mismatches: 0 };
  const dropIds = new Set(opts.dropIds ?? []);
  for (const id of dropIds) {
    const known = plan.excel_other_rows.some((m) => m.id === id) || plan.excel_contribution_rows.some((m) => m.id === id);
    if (!known) throw new Error(`afc: --drop-ids ${id} is not an excel-era row of account ${plan.account_id}`);
  }
  db.transaction(() => {
    if (opts.replaceExcelContributions) {
      for (const m of plan.excel_contribution_rows) {
        stmtDeleteMovement.run(m.id);
        out.deleted += 1;
      }
    }
    for (const id of dropIds) {
      if (opts.replaceExcelContributions && plan.excel_contribution_rows.some((m) => m.id === id)) continue;
      stmtDeleteMovement.run(id);
      out.deleted += 1;
    }
    for (const it of plan.items) {
      if (it.status === "insert") {
        stmtInsertContribution.run(plan.account_id, it.contribution.amount_clp, it.contribution.pay_ymd, afcContributionNote(it.contribution), it.units);
        out.inserted += 1;
      } else if (it.status === "update_units") {
        stmtUpdateUnits.run(it.units, it.existing_id);
        out.units_updated += 1;
      } else if (it.status === "mismatch") {
        out.mismatches += 1;
      }
    }
  })();
  return out;
}

// ---------------------------------------------------------------------------------------------
// Withdrawals (retiros) — units from the pay-date valor cuota, or the closing −Σ
// ---------------------------------------------------------------------------------------------

export type AfcWithdrawalPlanItem = {
  movement: AfcMovementRow;
  px: number;
  /** Magnitude to store (transfer legs store the magnitude; single-leg rows store it negative). */
  units_abs: number;
  closes_position: boolean;
  status: "set" | "unchanged";
};

function storedValuationOnOrAfter(accountId: number, dayYmd: string): { as_of_date: string; value: number } | null {
  return (
    (db
      .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? AND as_of_date >= ? ORDER BY as_of_date LIMIT 1`)
      .get(accountId, dayYmd) as { as_of_date: string; value: number } | undefined) ?? null
  );
}

/**
 * Units for every outflow (single-leg negative row without a P/L flow kind, or a transfer leaving
 * the account), walking the ledger in date order: a withdrawal after which the account's own
 * stored valuation reads 0 closes the position and takes exactly the cuotas held; any other one
 * is priced at the valor cuota of its date. Mutates nothing; `applyAfcWithdrawalUnits` writes.
 */
export function planAfcWithdrawalUnits(accountId: number): AfcWithdrawalPlanItem[] {
  const seriesKey = requireAfcSeriesKey(accountId);
  const rows = listAccountMovements(accountId);
  const items: AfcWithdrawalPlanItem[] = [];
  let running = 0;
  for (const m of rows) {
    const isTransfer = m.account_id == null;
    const outflow = isTransfer ? m.from_account_id === accountId : m.amount < 0;
    const plFlow = m.flow_kind === "cash_fee" || m.flow_kind === "savings_earnings";
    if (!outflow || plFlow) {
      const u = m.units_delta ?? 0;
      running = round4(running + (isTransfer ? (m.to_account_id === accountId ? Math.abs(u) : -Math.abs(u)) : u));
      continue;
    }
    if (m.currency !== "clp") throw new Error(`afc: withdrawal ${m.id} is ${m.currency}`);
    const px = requirePx(seriesKey, m.occurred_on);
    // Closing = the account's own next stored valuation reads 0 and nothing else moves the
    // ledger before it (a later row would mean this withdrawal did not empty the account).
    const nextStored = storedValuationOnOrAfter(accountId, m.occurred_on);
    const closes =
      nextStored?.value === 0 &&
      !rows.some((r) => r.id !== m.id && r.occurred_on > m.occurred_on && r.occurred_on <= nextStored.as_of_date);
    const unitsAbs = closes ? round4(running) : round4(Math.abs(m.amount) / px);
    const current = m.units_delta == null ? null : Math.abs(m.units_delta);
    const status: AfcWithdrawalPlanItem["status"] =
      current != null && Math.abs(current - unitsAbs) <= 0.00005 ? "unchanged" : "set";
    items.push({ movement: m, px, units_abs: unitsAbs, closes_position: closes, status });
    running = round4(running - unitsAbs);
  }
  return items;
}

export function applyAfcWithdrawalUnits(items: readonly AfcWithdrawalPlanItem[]): number {
  let n = 0;
  db.transaction(() => {
    for (const it of items) {
      if (it.status !== "set") continue;
      const isTransfer = it.movement.account_id == null;
      stmtUpdateUnits.run(isTransfer ? it.units_abs : -it.units_abs, it.movement.id);
      n += 1;
    }
  })();
  return n;
}

// ---------------------------------------------------------------------------------------------
// Estado cuatrimestral (cartola) — commission true-ups at the printed saldos
// ---------------------------------------------------------------------------------------------

export type AfcCartola = {
  period_from_ymd: string;
  period_to_ymd: string;
  saldo_inicial_ymd: string;
  saldo_inicial_clp: number;
  cotizaciones_clp: number;
  otros_ingresos_clp: number;
  ganancia_clp: number;
  total_ingresos_clp: number;
  comisiones_clp: number;
  otros_egresos_clp: number;
  uso_cuenta_clp: number;
  total_egresos_clp: number;
  saldo_final_ymd: string;
  saldo_final_clp: number;
  detalle: { employer: string; pay_month_ym: string; amount_clp: number }[];
};

export function afcCartolaTrueUpNoteKey(which: "inicial" | "final", dayYmd: string): string {
  return `AFC ajuste cartola — saldo ${which} ${dayYmd}`;
}

export type AfcCartolaTrueUp = {
  which: "inicial" | "final";
  day_ymd: string;
  saldo_clp: number;
  px: number;
  target_units: number;
  /** Ledger cuotas through the day, excluding this boundary's own true-up row. */
  ledger_units: number;
  /** Units the true-up row carries (negative = commission). */
  units: number;
  amount_clp: number;
  flow_kind: "cash_fee" | "savings_earnings" | null;
  existing_id: number | null;
  status: "insert" | "update" | "unchanged" | "none" | "delete";
};

export type AfcCartolaPlan = {
  account_id: number;
  cartola: AfcCartola;
  /** Certificate-imported contributions paid inside the period, checked against the cartola. */
  ledger_cotizaciones_clp: number;
  trueups: AfcCartolaTrueUp[];
};

function trueUpRowFor(accountId: number, key: string): AfcMovementRow | null {
  const rows = db
    .prepare(`SELECT id, occurred_on, amount, currency, units_delta, flow_kind, note, account_id, from_account_id, to_account_id
              FROM movements WHERE account_id = ? AND note LIKE ? ORDER BY id`)
    .all(accountId, `${key}%`) as AfcMovementRow[];
  if (rows.length > 1) throw new Error(`afc: ${rows.length} true-up rows carry «${key}»`);
  return rows[0] ?? null;
}

/**
 * True-ups at both printed saldos. The inicial boundary is planned first and its units are
 * folded into the ledger before the final boundary is measured (both computed against the
 * current DB plus the planned inicial row). The period's contributions in the ledger must equal
 * the cartola's «Total de cotizaciones» — otherwise the certificate import is incomplete and the
 * true-up would silently absorb missing cotizaciones as «commission».
 */
export function planAfcCartolaTrueUps(accountId: number, cartola: AfcCartola): AfcCartolaPlan {
  const seriesKey = requireAfcSeriesKey(accountId);
  const rows = listAccountMovements(accountId).filter((m) => m.account_id === accountId);
  const inPeriod = rows.filter(
    (m) =>
      m.occurred_on > cartola.saldo_inicial_ymd &&
      m.occurred_on <= cartola.saldo_final_ymd &&
      (m.note ?? "").startsWith("AFC cotización — período")
  );
  const ledger_cotizaciones_clp = inPeriod.reduce((a, m) => a + Math.round(m.amount), 0);
  if (ledger_cotizaciones_clp !== cartola.cotizaciones_clp) {
    throw new Error(
      `afc cartola: ledger cotizaciones ${ledger_cotizaciones_clp} in (${cartola.saldo_inicial_ymd}, ${cartola.saldo_final_ymd}] ≠ printed ${cartola.cotizaciones_clp} — import the certificate first`
    );
  }
  const trueups: AfcCartolaTrueUp[] = [];
  let carriedInicialUnits = 0;
  for (const which of ["inicial", "final"] as const) {
    const day = which === "inicial" ? cartola.saldo_inicial_ymd : cartola.saldo_final_ymd;
    const saldo = which === "inicial" ? cartola.saldo_inicial_clp : cartola.saldo_final_clp;
    const px = requirePx(seriesKey, day);
    const target = round4(saldo / px);
    const existing = trueUpRowFor(accountId, afcCartolaTrueUpNoteKey(which, day));
    const existingUnits = existing?.units_delta ?? 0;
    // Ledger through the day, minus this boundary's own row, plus the inicial row as planned.
    const ledger = round4(afpCuotasCumulativeThroughDate(accountId, day) - existingUnits + (which === "final" ? carriedInicialUnits : 0));
    const units = round4(target - ledger);
    const amount = Math.round(units * px);
    const flow_kind: AfcCartolaTrueUp["flow_kind"] = amount === 0 ? null : amount < 0 ? "cash_fee" : "savings_earnings";
    let status: AfcCartolaTrueUp["status"];
    if (Math.abs(amount) < 1) status = existing ? "delete" : "none";
    else if (!existing) status = "insert";
    else if (Math.abs((existing.units_delta ?? 0) - units) > 0.00005 || Math.round(existing.amount) !== amount) status = "update";
    else status = "unchanged";
    if (which === "inicial") {
      // What the final boundary will see: the planned inicial units replace the stored ones.
      carriedInicialUnits = round4(units - existingUnits);
    }
    trueups.push({ which, day_ymd: day, saldo_clp: saldo, px, target_units: target, ledger_units: ledger, units, amount_clp: amount, flow_kind, existing_id: existing?.id ?? null, status });
  }
  return { account_id: accountId, cartola, ledger_cotizaciones_clp, trueups };
}

const stmtInsertTrueUp = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
   VALUES (?, ?, 'clp', ?, ?, ?, ?)`
);
const stmtUpdateTrueUp = db.prepare(
  `UPDATE movements SET amount = ?, units_delta = ?, flow_kind = ?, note = ? WHERE id = ?`
);

function trueUpNote(t: AfcCartolaTrueUp, c: AfcCartola): string {
  return (
    `${afcCartolaTrueUpNoteKey(t.which, t.day_ymd)} · cartola ${c.period_from_ymd}..${c.period_to_ymd}` +
    ` · saldo $${t.saldo_clp} ÷ ${t.px} = ${t.target_units} cuotas vs ledger ${t.ledger_units}` +
    (t.which === "final" ? ` · comisiones impresas $${c.comisiones_clp}` : "")
  );
}

export function applyAfcCartolaTrueUps(plan: AfcCartolaPlan): { inserted: number; updated: number; deleted: number } {
  const out = { inserted: 0, updated: 0, deleted: 0 };
  db.transaction(() => {
    for (const t of plan.trueups) {
      const note = trueUpNote(t, plan.cartola);
      if (t.status === "insert") {
        stmtInsertTrueUp.run(plan.account_id, t.amount_clp, t.day_ymd, note, t.units, t.flow_kind);
        out.inserted += 1;
      } else if (t.status === "update") {
        stmtUpdateTrueUp.run(t.amount_clp, t.units, t.flow_kind, note, t.existing_id);
        out.updated += 1;
      } else if (t.status === "delete") {
        stmtDeleteMovement.run(t.existing_id);
        out.deleted += 1;
      }
    }
  })();
  return out;
}

// ---------------------------------------------------------------------------------------------
// The ingest kind: both documents → the rebuild, with its report
// ---------------------------------------------------------------------------------------------

export function afcCertificateFromPayload(c: UnemploymentFundDocumentsPayload["certificate"]): AfcCotizacionesCertificate {
  return {
    legs: c.legs.map((l) => ({
      period_ym: l.period_month,
      employer_rut: l.employer_rut,
      employer: l.employer,
      renta_imponible_clp: l.taxable_income,
      amount_clp: l.amount,
      pay_ymd: l.paid_on,
    })),
    total_clp: c.total,
  };
}

export function afcCartolaFromPayload(s: UnemploymentFundDocumentsPayload["statements"][number]): AfcCartola {
  return {
    period_from_ymd: s.period_from,
    period_to_ymd: s.period_to,
    saldo_inicial_ymd: s.opening.date,
    saldo_inicial_clp: s.opening.balance,
    cotizaciones_clp: s.contributions,
    otros_ingresos_clp: s.other_income,
    ganancia_clp: s.gain,
    total_ingresos_clp: s.total_income,
    comisiones_clp: s.commissions,
    otros_egresos_clp: s.other_outflows,
    uso_cuenta_clp: s.account_use,
    total_egresos_clp: s.total_outflows,
    saldo_final_ymd: s.closing.date,
    saldo_final_clp: s.closing.balance,
    detalle: s.detail.map((d) => ({ employer: d.employer, pay_month_ym: d.pay_month, amount_clp: d.amount })),
  };
}

function fmt(n: number): string {
  return Math.round(n).toLocaleString("en-US"); // convention-ok: import report text
}

class Rollback extends Error {}

function resolveAfcAccountId(explicit: number | null): number {
  if (explicit != null) return explicit;
  const rows = db.prepare(`SELECT id FROM accounts WHERE fund_series_key = ? ORDER BY id`).all(AFC_CIC_SERIES_KEY) as { id: number }[];
  if (rows.length !== 1) throw new Error(`expected one account on ${AFC_CIC_SERIES_KEY}, found ${rows.length}; send the account id`);
  return rows[0]!.id;
}

/**
 * Rebuild / reconcile the AFC cuota ledger from the documents, in one transaction: (1) the
 * certificate's contributions (insert / update units / mismatch), optionally deleting the
 * excel-era contribution rows the certificate supersedes and the ids listed; (2) units on every
 * withdrawal (pay-date valor cuota, or the closing −Σ when the account's stored valuation reads
 * 0 right after); (3) one true-up per cartola boundary; (4) closing withdrawals re-measured after
 * them; (5) checks on the resulting ledger. Without `apply` the transaction is ROLLED BACK after
 * the report, so the report shows the exact post-import ledger and nothing is written.
 */
export function applyUnemploymentFundDocuments(payload: UnemploymentFundDocumentsPayload): UnemploymentFundDocumentsApplyDetails {
  const report: string[] = [];
  const log = (line: string) => report.push(line);
  const accountId = resolveAfcAccountId(payload.account_id);
  const cert = afcCertificateFromPayload(payload.certificate);
  const replaceExcel = payload.options.replace_excel_rows;
  const dropIds = payload.options.drop_movement_ids;
  log(`Certificado de cotizaciones: ${cert.legs.length} legs, total ${fmt(cert.total_clp)} CLP`);
  try {
    db.transaction(() => {
      const plan = planAfcCertImport(accountId, cert);
      const counts = { insert: 0, unchanged: 0, update_units: 0, mismatch: 0 };
      log(`\n[1] Contributions — account ${accountId}, series ${plan.series_key}`);
      log("status         período  pago         pesos       px       cuotas  employer");
      for (const it of plan.items) {
        counts[it.status] += 1;
        const c = it.contribution;
        log(
          `${it.status.padEnd(14)} ${c.period_ym}  ${c.pay_ymd}  ${fmt(c.amount_clp).padStart(9)}  ${it.px.toFixed(2).padStart(8)}  ${it.units.toFixed(4).padStart(9)}  ${c.employer}${it.detail ? `  (${it.detail})` : ""}`
        );
      }
      log(`→ insert ${counts.insert}, unchanged ${counts.unchanged}, update units ${counts.update_units}, mismatch ${counts.mismatch}`);
      if (plan.excel_contribution_rows.length > 0) {
        log(
          `\nExcel-era contribution rows (import:excel|afc-flow, amount > 0): ${plan.excel_contribution_rows.length}, ` +
            `${fmt(plan.excel_contribution_rows.reduce((a, m) => a + m.amount, 0))} CLP — ${replaceExcel ? "DELETED (superseded by the certificate)" : "kept (pass --replace-excel-rows to delete)"}`
        );
      }
      if (plan.excel_other_rows.length > 0) {
        log(`\nExcel-era non-contribution rows (kept unless listed in --drop-ids):`);
        for (const m of plan.excel_other_rows) {
          log(`  id ${m.id}  ${m.occurred_on}  ${fmt(m.amount).padStart(12)}  ${dropIds.includes(m.id) ? "DROP" : "keep"}  ${m.note ?? ""}`);
        }
      }
      const r1 = applyAfcCertImport(plan, { replaceExcelContributions: replaceExcel, dropIds });
      log(`→ wrote: inserted ${r1.inserted}, units updated ${r1.units_updated}, deleted ${r1.deleted}, mismatches skipped ${r1.mismatches}`);

      const withdrawals = (label: string, quiet: boolean) => {
        const wplan = planAfcWithdrawalUnits(accountId);
        log(`\n${label} — ${wplan.length}`);
        for (const w of wplan) {
          if (quiet && w.status === "unchanged") continue;
          log(
            `${w.status.padEnd(10)} id ${w.movement.id}  ${w.movement.occurred_on}  ${fmt(Math.abs(w.movement.amount)).padStart(12)}  px ${w.px.toFixed(2)}  cuotas ${w.units_abs.toFixed(4)}${w.closes_position ? "  (closes the position)" : ""}`
          );
        }
        log(`→ units set on ${applyAfcWithdrawalUnits(wplan)} withdrawal(s)`);
      };
      withdrawals("[2] Withdrawals", false);

      for (const statement of payload.statements) {
        const cartola = afcCartolaFromPayload(statement);
        log(
          `\n[3] Cartola ${cartola.period_from_ymd}..${cartola.period_to_ymd}: saldo ${cartola.saldo_inicial_ymd} ${fmt(cartola.saldo_inicial_clp)} → ${cartola.saldo_final_ymd} ${fmt(cartola.saldo_final_clp)}; ` +
            `cotizaciones ${fmt(cartola.cotizaciones_clp)}, ganancia ${fmt(cartola.ganancia_clp)}, comisiones ${fmt(cartola.comisiones_clp)}`
        );
        const cplan = planAfcCartolaTrueUps(accountId, cartola);
        for (const t of cplan.trueups) {
          log(
            `${t.status.padEnd(10)} saldo ${t.which.padEnd(7)} ${t.day_ymd}  target ${t.target_units.toFixed(4)} cuotas, ledger ${t.ledger_units.toFixed(4)} → true-up ${t.units.toFixed(4)} cuotas = ${fmt(t.amount_clp)} CLP (${t.flow_kind ?? "—"})`
          );
        }
        const r3 = applyAfcCartolaTrueUps(cplan);
        log(`→ true-ups: inserted ${r3.inserted}, updated ${r3.updated}, deleted ${r3.deleted}`);
      }
      if (payload.statements.length > 0) withdrawals("[4] Withdrawals after the true-ups (changed rows only)", true);

      log(`\n[5] Resulting ledger checks`);
      const stored = db
        .prepare(`SELECT as_of_date, value FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
        .all(accountId) as { as_of_date: string; value: number }[];
      const diffs: number[] = [];
      for (const v of stored) {
        const px = fundUnitClpOnOrBefore(AFC_CIC_SERIES_KEY, v.as_of_date);
        if (px == null) continue;
        const derived = Math.round(afpCuotasCumulativeThroughDate(accountId, v.as_of_date) * px);
        if (v.value > 0) diffs.push((derived - v.value) / v.value);
      }
      if (diffs.length > 0) {
        const abs = diffs.map(Math.abs).sort((a, b) => a - b);
        log(
          `stored excel month-ends vs ledger × valor cuota: n=${diffs.length}, median |diff| ${(abs[Math.floor(abs.length / 2)]! * 100).toFixed(2)}%, max |diff| ${(abs[abs.length - 1]! * 100).toFixed(2)}%`
        );
      }
      const last = db
        .prepare(`SELECT occurred_on FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ? ORDER BY date(occurred_on) DESC, id DESC LIMIT 1`)
        .get(accountId, accountId, accountId) as { occurred_on: string } | undefined;
      if (last) log(`cuotas after the last movement (${last.occurred_on}): ${afpCuotasCumulativeThroughDate(accountId, last.occurred_on).toFixed(4)}`);
      if (!payload.apply) throw new Rollback("report only");
    })();
    log(`\nAPPLIED.`);
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
    log(`\nREPORT ONLY — every change above was rolled back. Re-run with --apply to write.`);
  }
  return { applied: payload.apply, account_id: accountId, report };
}
