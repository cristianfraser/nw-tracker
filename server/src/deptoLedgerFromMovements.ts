/**
 * DB-first depto ledger: reconstructs the dividendos payment ledger from the PROPERTY
 * account's movements (pie + cuotas + prepagos — the mortgage account is the non-pie
 * subset), whose notes encode every runtime-critical field via
 * `buildDeptoDividendosMovementNote` (see `parseDeptoDividendosMovementNote`).
 *
 * This is the ONLY runtime ledger source. `depto_dividendos_sheet_rows` is import/manual
 * staging (spreadsheet master mirror) — never read on request paths.
 *
 * Derivations for fields not present in notes (all display-only or recomputed):
 * - `uf_clp_day` from `uf_daily` (same as the sheet loader — the note `ufdia` is ignored),
 * - `restante_clp` = round(cruf × ufdia); `valor_vivienda_uf` = roundUf4(vnuf + cruf),
 * - UF insurance legs from CLP ÷ ufdia; deltas from consecutive rows; acumulados as cumsums,
 * - analysis columns via `computeMortgagePaymentAnalytics` (already used for manual rows).
 *
 * Lives in its own module (not deptoDividendosLedger.ts) to avoid an import cycle:
 * this loader needs mortgagePaymentAnalytics, which imports types from deptoDividendosLedger.
 */
import { db } from "./db.js";
import {
  enrichDeptoRowsUfClpFromDb,
  parseDeptoDividendosMovementNote,
  deptoMortgageCloseClpBySnapshotDates,
  deptoSueciaPropertyCloseClpBySnapshotDates,
  type DeptoAccountMarkAtYmd,
  type DeptoMortgageSheetRow,
} from "./deptoDividendosLedger.js";
import {
  computeMortgagePaymentAnalytics,
  mortgageAnalyticsMetaFromLedger,
  roundUf4,
} from "./mortgagePaymentAnalytics.js";
import { ufClpBySnapshotDatesAsc, ufRowOnOrBefore } from "./fxRates.js";

export const DEPTO_PROPERTY_ACCOUNT_NOTES = "import:excel|key=property";

const DEPTO_NOTE_PREFIXES = [
  "import:excel|depto-dividendos",
  "import:excel|depto-mortgage",
  "manual|depto-dividendos",
  "manual|depto-mortgage",
] as const;

function isDeptoNote(note: string | null): boolean {
  return note != null && DEPTO_NOTE_PREFIXES.some((p) => note.startsWith(p));
}

function roundUf5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

type PropertyMovementRow = {
  id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

function deptoPropertyAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT id FROM accounts WHERE notes = ? AND account_kind = 'master' ORDER BY id LIMIT 1`
    )
    .get(DEPTO_PROPERTY_ACCOUNT_NOTES) as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * Rebuild the full dividendos ledger (sorted by occurred_on, cuota — snapshot fns and
 * `defaultIncendioClpFromLedger` rely on the order) from property-account movements.
 * Returns [] when no depto property is tracked; throws when depto-note movements exist
 * without a resolvable property master (data problem — fix data, not the loader).
 */
export function loadDeptoLedgerFromMovements(): DeptoMortgageSheetRow[] {
  const propertyId = deptoPropertyAccountId();
  if (propertyId == null) {
    const stray = db
      .prepare(
        `SELECT COUNT(*) AS c FROM movements
         WHERE note LIKE 'import:excel|depto-%' OR note LIKE 'manual|depto-%'`
      )
      .get() as { c: number };
    if (stray.c > 0) {
      throw new Error(
        `depto ledger: ${stray.c} depto-note movements exist but no property master with notes '${DEPTO_PROPERTY_ACCOUNT_NOTES}'`
      );
    }
    return [];
  }

  const movements = (
    db
      .prepare(
        `SELECT id, occurred_on, amount_clp, note FROM movements
         WHERE account_id = ? ORDER BY occurred_on, id`
      )
      .all(propertyId) as PropertyMovementRow[]
  ).filter((m) => isDeptoNote(m.note));
  if (movements.length === 0) return [];

  // Pass 1 — base rows straight from the notes (+ per-row uf_daily for derivations).
  const base: DeptoMortgageSheetRow[] = movements.map((m) => {
    const p = parseDeptoDividendosMovementNote(m.note);
    if (!p || !p.cuota) {
      throw new Error(
        `depto ledger: property movement ${m.id} (${m.occurred_on}) has an unparseable depto note`
      );
    }
    const ufDay = ufRowOnOrBefore(m.occurred_on)?.clp_per_uf ?? null;
    const cruf = p.credito_restante_uf ?? null;
    const vnuf = p.valor_neto_uf ?? null;
    const restanteClp = cruf != null && ufDay != null ? Math.round(cruf * ufDay) : null;
    const viviendaUf = cruf != null && vnuf != null ? roundUf4(cruf + vnuf) : null;
    const incendioClp = p.incendio_clp ?? null;
    const desgravamenClp = p.desgravamen_clp ?? null;
    const incendioUf =
      incendioClp != null && ufDay != null && ufDay > 0 ? roundUf5(incendioClp / ufDay) : null;
    const desgravamenUf =
      desgravamenClp != null && ufDay != null && ufDay > 0
        ? roundUf5(desgravamenClp / ufDay)
        : null;
    const segurosClp =
      incendioClp != null || desgravamenClp != null
        ? (incendioClp ?? 0) + (desgravamenClp ?? 0)
        : null;
    const segurosUf =
      incendioUf != null || desgravamenUf != null
        ? roundUf5((incendioUf ?? 0) + (desgravamenUf ?? 0))
        : null;
    return {
      cuota: p.cuota,
      occurred_on: m.occurred_on,
      pago_clp: Math.abs(m.amount_clp),
      pago_uf: p.amount_uf ?? null,
      pct_dividendo: null,
      uf_clp_day: ufDay,
      mm_pct: null,
      yy_pct: null,
      tasa_plus: null,
      credito_restante_uf: cruf,
      pct_credito_uf: null,
      restante_clp: restanteClp,
      pct_de_total: null,
      delta_credito_clp: null,
      valor_neto_uf: vnuf,
      valor_neto_clp: p.valor_neto_clp ?? null,
      pagado_neto_uf: p.pagado_neto_uf ?? null,
      delta_valor_neto_clp: null,
      valor_vivienda_uf: viviendaUf,
      valor_vivienda_clp:
        viviendaUf != null && ufDay != null ? Math.round(viviendaUf * ufDay) : null,
      min_uf: p.min_uf ?? null,
      incendio_clp: incendioClp,
      incendio_uf: incendioUf,
      desgravamen_clp: desgravamenClp,
      desgravamen_uf: desgravamenUf,
      total_seguros_uf: segurosUf,
      total_seguros_clp: segurosClp,
      amortizacion_clp: p.amortizacion_clp ?? null,
      amortizacion_uf: p.amortizacion_uf ?? null,
      amortizacion_ext_clp: p.amortizacion_ext_clp ?? null,
      amortizacion_ext_uf: p.amortizacion_ext_uf ?? null,
      interes_clp: p.interes_clp ?? null,
      interes_uf: p.interes_uf ?? null,
      delta_credito_amort_clp: null,
      interes_oculto_clp: null,
      interes_oculto_b_clp: null,
      interes_real_clp: null,
      interes_calculado_uf: null,
      amort_interes_text: null,
      pago_acumulado_clp: p.pago_acumulado_clp ?? null,
      amort_acum_clp: null,
      interes_acum_clp: null,
    } satisfies DeptoMortgageSheetRow;
  });

  base.sort((a, b) => {
    const c = a.occurred_on.localeCompare(b.occurred_on);
    return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
  });

  // Pass 2 — consecutive deltas, cumsums, and recomputed analysis columns.
  const meta = mortgageAnalyticsMetaFromLedger(base);
  let amortAcum = 0;
  let interesAcum = 0;
  let anyAmort = false;
  let anyInteres = false;
  for (let i = 0; i < base.length; i++) {
    const row = base[i]!;
    const prior = i > 0 ? base[i - 1]! : null;
    if (prior?.restante_clp != null && row.restante_clp != null) {
      row.delta_credito_clp = prior.restante_clp - row.restante_clp;
    }
    if (prior?.valor_neto_clp != null && row.valor_neto_clp != null) {
      row.delta_valor_neto_clp = row.valor_neto_clp - prior.valor_neto_clp;
    }
    if (row.amortizacion_clp != null || row.amortizacion_ext_clp != null) {
      amortAcum += (row.amortizacion_clp ?? 0) + (row.amortizacion_ext_clp ?? 0);
      anyAmort = true;
    }
    if (row.interes_clp != null) {
      interesAcum += row.interes_clp;
      anyInteres = true;
    }
    row.amort_acum_clp = anyAmort ? Math.round(amortAcum) : null;
    row.interes_acum_clp = anyInteres ? Math.round(interesAcum) : null;
    Object.assign(row, computeMortgagePaymentAnalytics(row, prior, base, meta));
  }

  return enrichDeptoRowsUfClpFromDb(base);
}

/**
 * Suecia-style property or mortgage CLP mark at a calendar date: movement-ledger UF
 * balance × `uf_daily` on or before `asOfYmd` (same math the sheet-based mark used).
 */
export function deptoAccountMarkClpAtYmd(
  categorySlug: string,
  asOfYmd: string
): DeptoAccountMarkAtYmd | null {
  if (categorySlug !== "property" && categorySlug !== "mortgage") return null;
  const ledger = loadDeptoLedgerFromMovements();
  if (!ledger.length) return null;

  const dates = [asOfYmd] as const;
  const ufMap = ufClpBySnapshotDatesAsc(dates);
  const closeBy =
    categorySlug === "property"
      ? deptoSueciaPropertyCloseClpBySnapshotDates(dates, ledger, ufMap)
      : deptoMortgageCloseClpBySnapshotDates(dates, ledger, ufMap);
  const clp = closeBy.get(asOfYmd);
  if (clp == null || !Number.isFinite(clp)) return null;
  return { value_clp: clp, as_of_date: asOfYmd };
}
