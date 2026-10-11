/**
 * `mortgage.sheet_payments` → the depto ledger. The mortgage sheet (the user's Numbers table,
 * read in place by ingest) is the user's own record of every capital event of the loan: the pie,
 * the prepagos and each cuota once the bank posted it and the user paid it.
 *
 * Per sheet row, by label («pie», «prepago 2», «32»):
 * - already in `depto_payments` → every figure is cross-checked against the stored row (pesos to
 *   the peso, UF to `UF_TOLERANCE`); a difference is DRIFT and the whole import is refused —
 *   the two are records of the same payment, and neither is rewritten from the other. The one
 *   write on a stored row is filling `max_uf` the ledger never had (the sheet's cuota máxima).
 * - a cuota the ledger lacks, dated today or earlier → written through `commitMortgagePayment`
 *   exactly as the form would (the sheet's interés, seguros, min UF and posted crédito restante;
 *   the pesos and date are the sheet's), after checking that the app's UF for that day is the
 *   sheet's and that the split the app derives (amortización / ext) is the sheet's.
 * - a cuota dated after today → `not_due` (posted ahead of the payment; written once the day comes).
 * - a pie or prepago the ledger lacks → drift (those are entered by hand, see AGENTS.md).
 * A difference the user has declared (`accepted` in the payload, from the config) is reported
 * under `accepted` instead and does not block the import.
 *
 * Everything runs in one transaction that is rolled back without `apply` or on any drift, so the
 * report is the exact outcome and a refused import writes nothing. An applied document is
 * recorded in `mortgage_sheet_imports`; the same sha256 sent again answers `duplicate`.
 */
import type {
  MortgageSheetPaymentRow,
  MortgageSheetPaymentsApplyDetails,
  MortgageSheetPaymentsPayload,
  MortgageSheetRowOutcome,
} from "nw-tracker-contracts";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import type { DeptoMortgageSheetRow } from "./deptoDividendosLedger.js";
import { loadDeptoLedgerFromMovements } from "./deptoLedgerFromMovements.js";
import { ufRowOnOrBefore } from "./fxRates.js";
import { invalidateAggregationForAccountDate } from "./aggregationCache.js";
import { commitMortgagePayment, deptoMortgageAccountId, deptoPropertyAccountId } from "./mortgagePaymentCreate.js";
import { computeMortgagePaymentRow } from "./mortgagePaymentCompute.js";
import type { MortgagePaymentInput } from "./mortgagePaymentTypes.js";

/** 4-decimal UF figures on both sides; 0,0002 is the CLP→UF rounding noise, never a real gap. */
export const UF_TOLERANCE = 0.0002;
const CLP_TOLERANCE = 1;
/** The sheet types the UF with two decimals; `uf_daily` carries the same figure. */
const UF_DAY_TOLERANCE = 0.011;

type Drift = MortgageSheetPaymentsApplyDetails["drift"][number];

export type MortgageSheetApplyOutcome = {
  status: "applied" | "duplicate" | "conflict";
  message?: string;
  details: MortgageSheetPaymentsApplyDetails;
};

class RollbackAfterReport extends Error {}

function near(a: number | null | undefined, b: number | null | undefined, tol: number): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return Math.abs(a - b) <= tol;
}

function compareStored(sheet: MortgageSheetPaymentRow, stored: DeptoMortgageSheetRow): Drift[] {
  const drift: Drift[] = [];
  const add = (field: string, s: number | string | null, l: number | string | null) => drift.push({ label: sheet.label, field, sheet: s, ledger: l });
  if (sheet.paid_on !== stored.occurred_on) add("paid_on", sheet.paid_on, stored.occurred_on);
  if (!near(sheet.pago_clp, stored.pago_clp, CLP_TOLERANCE)) add("pago_clp", sheet.pago_clp, stored.pago_clp);
  if (!near(sheet.pago_uf, stored.pago_uf, UF_TOLERANCE)) add("pago_uf", sheet.pago_uf, stored.pago_uf);
  if (!near(sheet.credito_restante_uf, stored.credito_restante_uf, UF_TOLERANCE)) {
    add("credito_restante_uf", sheet.credito_restante_uf, stored.credito_restante_uf);
  }
  const clpFields = ["interes_clp", "incendio_clp", "desgravamen_clp", "amortizacion_clp", "amortizacion_ext_clp"] as const;
  for (const f of clpFields) {
    // A missing ext on either side is a zero prepago.
    const s = f === "amortizacion_ext_clp" ? (sheet[f] ?? 0) : sheet[f];
    const l = f === "amortizacion_ext_clp" ? (stored[f] ?? 0) : stored[f];
    if (sheet.kind === "pie" && s == null) continue;
    if (!near(s, l, CLP_TOLERANCE)) add(f, s, l);
  }
  if (sheet.kind === "cuota" && !near(sheet.min_uf, stored.min_uf, UF_TOLERANCE)) add("min_uf", sheet.min_uf, stored.min_uf);
  if (stored.max_uf != null && !near(sheet.max_uf, stored.max_uf, UF_TOLERANCE)) add("max_uf", sheet.max_uf, stored.max_uf);
  return drift;
}

function fillMaxUf(cuota: string, maxUf: number): void {
  db.prepare(`UPDATE depto_payments SET max_uf = ? WHERE cuota = ? AND max_uf IS NULL`).run(maxUf, cuota);
}

function mortgageMovementIdForCuota(cuota: string): number | null {
  const row = db.prepare(`SELECT movement_id FROM depto_payments WHERE kind = 'mortgage' AND cuota = ?`).get(cuota) as
    | { movement_id: number }
    | undefined;
  return row?.movement_id ?? null;
}

function paymentInputFromSheet(r: MortgageSheetPaymentRow): MortgagePaymentInput {
  return {
    occurred_on: r.paid_on,
    pago_clp: r.pago_clp,
    interes_clp: r.interes_clp!,
    incendio_clp: r.incendio_clp!,
    desgravamen_clp: r.desgravamen_clp!,
    cuota: r.label,
    min_uf: r.min_uf!,
    max_uf: r.max_uf,
    credito_restante_uf: r.credito_restante_uf,
  };
}

/** The app must reproduce the sheet's own split before the row is written. */
function checkDerivedSplit(r: MortgageSheetPaymentRow, ledger: readonly DeptoMortgageSheetRow[], drift: Drift[]): boolean {
  const before = drift.length;
  const uf = ufRowOnOrBefore(r.paid_on);
  if (!uf || uf.date !== r.paid_on) {
    drift.push({ label: r.label, field: "uf_day", sheet: r.uf_day, ledger: uf ? `${uf.clp_per_uf} (${uf.date})` : null });
    return false;
  }
  if (!near(uf.clp_per_uf, r.uf_day, UF_DAY_TOLERANCE)) {
    drift.push({ label: r.label, field: "uf_day", sheet: r.uf_day, ledger: uf.clp_per_uf });
    return false;
  }
  let computed;
  try {
    computed = computeMortgagePaymentRow(ledger, paymentInputFromSheet(r));
  } catch (e) {
    drift.push({ label: r.label, field: "compute", sheet: e instanceof Error ? e.message : String(e), ledger: null });
    return false;
  }
  const s = computed.sheet;
  if (!near(s.amortizacion_clp, r.amortizacion_clp, CLP_TOLERANCE)) {
    drift.push({ label: r.label, field: "amortizacion_clp", sheet: r.amortizacion_clp, ledger: s.amortizacion_clp });
  }
  if (!near(s.amortizacion_ext_clp ?? 0, r.amortizacion_ext_clp ?? 0, CLP_TOLERANCE)) {
    drift.push({ label: r.label, field: "amortizacion_ext_clp", sheet: r.amortizacion_ext_clp, ledger: s.amortizacion_ext_clp ?? 0 });
  }
  if (!near(s.pago_uf, r.pago_uf, UF_TOLERANCE)) drift.push({ label: r.label, field: "pago_uf", sheet: r.pago_uf, ledger: s.pago_uf });
  return drift.length === before;
}

/** The newest regular (numbered) cuota's payment day in the ledger — what the run scheduler asks. */
export function latestRegularMortgageCuotaPaidOn(): string | null {
  const row = db
    .prepare(
      `SELECT MAX(m.occurred_on) AS d FROM depto_payments p JOIN movements m ON m.id = p.movement_id
       WHERE p.kind = 'mortgage' AND p.cuota GLOB '[0-9]*'`
    )
    .get() as { d: string | null };
  return row.d ?? null;
}

export function applyMortgageSheetPayments(payload: MortgageSheetPaymentsPayload): MortgageSheetApplyOutcome {
  const details: MortgageSheetPaymentsApplyDetails = {
    document: payload.document.name,
    applied: false,
    rows: [],
    projected: payload.projected,
    drift: [],
    accepted: [],
  };
  const acceptedReason = new Map(payload.accepted.map((a) => [`${a.label}|${a.field}`, a.reason]));
  const already = db.prepare(`SELECT id, applied_at FROM mortgage_sheet_imports WHERE sha256 = ? ORDER BY id DESC LIMIT 1`).get(payload.document.sha256) as
    | { id: number; applied_at: string }
    | undefined;
  if (already && payload.apply) {
    return { status: "duplicate", message: `${payload.document.name} (sha256 ${payload.document.sha256.slice(0, 12)}) was applied ${already.applied_at}`, details };
  }

  const mortgageId = deptoMortgageAccountId();
  const today = chileCalendarTodayYmd();
  const written: MortgageSheetRowOutcome[] = [];
  const run = db.transaction(() => {
    let ledger = loadDeptoLedgerFromMovements();
    const byLabel = new Map(ledger.map((r) => [r.cuota, r]));
    for (const r of payload.rows) {
      const stored = byLabel.get(r.label);
      if (stored) {
        const d = compareStored(r, stored).filter((x) => {
          const reason = acceptedReason.get(`${x.label}|${x.field}`);
          if (reason == null) return true;
          details.accepted.push({ ...x, reason });
          return false;
        });
        details.drift.push(...d);
        const filled: string[] = [];
        if (d.length === 0 && stored.max_uf == null && r.max_uf != null) {
          fillMaxUf(r.label, r.max_uf);
          filled.push("max_uf");
        }
        details.rows.push({ label: r.label, paid_on: r.paid_on, status: "checked", filled, mortgage_movement_id: mortgageMovementIdForCuota(r.label) });
        continue;
      }
      if (r.kind !== "cuota") {
        details.drift.push({ label: r.label, field: "row", sheet: `${r.kind} ${r.paid_on} $${r.pago_clp}`, ledger: null });
        details.rows.push({ label: r.label, paid_on: r.paid_on, status: "checked", filled: [], mortgage_movement_id: null });
        continue;
      }
      if (r.paid_on > today) {
        details.rows.push({ label: r.label, paid_on: r.paid_on, status: "not_due", filled: [], mortgage_movement_id: null });
        continue;
      }
      if (!checkDerivedSplit(r, ledger, details.drift)) {
        details.rows.push({ label: r.label, paid_on: r.paid_on, status: "written", filled: [], mortgage_movement_id: null });
        continue;
      }
      const committed = commitMortgagePayment(mortgageId, paymentInputFromSheet(r), { origin: "import" });
      const outcome: MortgageSheetRowOutcome = { label: r.label, paid_on: r.paid_on, status: "written", filled: [], mortgage_movement_id: committed.mortgage_movement_id };
      details.rows.push(outcome);
      written.push(outcome);
      ledger = loadDeptoLedgerFromMovements();
    }
    if (details.drift.length > 0 || !payload.apply) throw new RollbackAfterReport();
    db.prepare(
      `INSERT INTO mortgage_sheet_imports (document_name, sha256, document_size, document_modified_at, rows_written, rows_checked)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      payload.document.name,
      payload.document.sha256,
      payload.document.size,
      payload.document.modified_at,
      written.length,
      details.rows.filter((x) => x.status === "checked").length
    );
  });
  try {
    run();
  } catch (e) {
    if (!(e instanceof RollbackAfterReport)) throw e;
    for (const w of written) w.mortgage_movement_id = null;
  } finally {
    // The ledger was re-read inside the transaction after each write (the next row's compute
    // needs it), so the memo holds rows a rollback took back — and max_uf fills the DB no
    // longer has. Drop everything built on it, whatever the outcome (2026-10-11: a report-mode
    // run followed by the live apply read cuota 32 as stored and wrote nothing).
    if (written.length > 0 || details.rows.some((r) => r.filled.length > 0)) {
      const earliest = details.rows.reduce((d, r) => (d == null || r.paid_on < d ? r.paid_on : d), null as string | null)!;
      invalidateAggregationForAccountDate(mortgageId, earliest);
      invalidateAggregationForAccountDate(deptoPropertyAccountId(), earliest);
    }
  }
  if (details.drift.length > 0) {
    const first = details.drift[0]!;
    return {
      status: "conflict",
      message: `${details.drift.length} difference(s) between the sheet and the ledger — nothing written (first: row ${first.label} ${first.field}: sheet ${first.sheet}, ledger ${first.ledger})`,
      details,
    };
  }
  details.applied = payload.apply;
  return { status: "applied", details };
}
