/**
 * DB-first depto ledger: reconstructs the dividendos payment ledger from the PROPERTY
 * account's movements (pie + cuotas + prepagos — the mortgage account is the non-pie
 * subset) joined with `loan_payments` (what the bank states: the balance after each payment and
 * the min / max cuota in UF, the parts of the charge in pesos) and the property's appraisals
 * (the property account's `valuations`, UF). Movement notes are human provenance only.
 *
 * This is the ONLY runtime ledger source.
 *
 * Everything else is derived here, never stored:
 * - `uf_clp_day` from `uf_daily` (on or before the payment day),
 * - the payment and its parts in UF: pesos ÷ UF día (payment to 5 decimals, parts to 4; an
 *   extra amortization of 0 has no UF figure),
 * - gross `valor_vivienda_uf`: the latest appraisal on or before the row,
 * - `valor_neto_uf` = gross − crédito restante (4 decimals), `valor_neto_clp` = × UF día,
 * - `pagado_neto_uf` = the balance after the pie − crédito restante,
 * - `pago_acumulado_clp` = Σ pesos paid in ledger order, `restante_clp` = cruf × UF día,
 * - insurance UF legs, deltas from consecutive rows, acumulados as cumsums,
 * - analysis columns via `computeMortgagePaymentAnalytics` (already used for manual rows).
 *
 * Lives in its own module (not deptoDividendosLedger.ts) to avoid an import cycle:
 * this loader needs mortgagePaymentAnalytics, which imports types from deptoDividendosLedger.
 */
import { accountBucketKindSlug } from "./accountBucket.js";
import { cacheKeyDeptoLedger } from "./cacheFamilies.js";
import { getAggregationCached } from "./cacheRegistry.js";
import { db } from "./db.js";
import {
  accountHasRole,
  deptoPropertyIdOfAccount,
  propertyLoanPairs,
  type PropertyLoanPair,
} from "./accountRoles.js";
import { accountProfileOptional } from "./accountProfile.js";
import { declareAccountsTrimmedTogether } from "./markSeriesStore.js";
import {
  assertDeptoLoanPaymentCurrencies,
  assertDeptoPrepagoSequencing,
  deptoLedgerChronoCompare,
  enrichDeptoRowsUfClpFromDb,
  deptoMortgageCloseClpBySnapshotDates,
  deptoPropertyCloseClpBySnapshotDates,
  isDeptoPieCuota,
  propertyAppraisalsUfAsc,
  sumPresent,
  type DeptoAccountMarkAtYmd,
  type DeptoMortgageSheetRow,
  type LoanPaymentRow,
} from "./deptoDividendosLedger.js";
import { movementClpLegOrZero, type MovementAmountFields } from "./movementAmounts.js";
import {
  computeMortgagePaymentAnalytics,
  mortgageAnalyticsMetaFromLedger,
  roundUf4,
} from "./mortgagePaymentAnalytics.js";
import { ufClpBySnapshotDatesAsc, ufRowOnOrBefore } from "./fxRates.js";

/** The depto property's identity (`accountIdentityKeys.ts`): what seeds its `property` role. */
export { PROPERTY_ACCOUNT_IMPORT_KEY as DEPTO_PROPERTY_ACCOUNT_IMPORT_KEY } from "./accountIdentityKeys.js";

const accountBucketsStmt = db.prepare(
  `SELECT a.id, g.slug FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id`
);

/**
 * The property and the mortgage read one ledger (the property's net equity is its appraisal less
 * the mortgage's balance): a change to either moves both, so the change log trims and drops them
 * together (`markInputChanges.ts`).
 */
declareAccountsTrimmedTogether("depto_ledger", () =>
  (accountBucketsStmt.all() as { id: number; slug: string }[])
    .filter((r) => {
      const kind = accountBucketKindSlug(r.slug);
      return kind === "property" || kind === "mortgage";
    })
    .map((r) => r.id)
);

function roundUf5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

type PropertyPaymentJoinRow = LoanPaymentRow & MovementAmountFields & {
  occurred_on: string;
};


/** Pesos ÷ UF día at 4 decimals; null when either is missing. */
function clpToUf4(clp: number | null, ufDay: number | null): number | null {
  if (clp == null || ufDay == null || !(ufDay > 0)) return null;
  return roundUf4(clp / ufDay);
}

/**
 * Fails fast on `loan_payments` rows the roles cannot place: a property-leg row on an account
 * holding no `property` role, a loan-leg row on an account holding no `loan_of` role, a row whose
 * `loan_account_id` is not that property's loan (or not the loan its movement sits on).
 */
function assertLoanPaymentsPlaced(pairs: readonly PropertyLoanPair[]): void {
  const loanOfProperty = new Map(pairs.map((p) => [p.propertyAccountId, p.loanAccountId]));
  const propertyOfLoan = new Map<number, number>();
  for (const p of pairs) if (p.loanAccountId != null) propertyOfLoan.set(p.loanAccountId, p.propertyAccountId);
  const rows = db
    .prepare(
      `SELECT p.movement_id, p.leg, p.loan_account_id, m.account_id FROM loan_payments p
       JOIN movements m ON m.id = p.movement_id`
    )
    .all() as { movement_id: number; leg: string; loan_account_id: number; account_id: number | null }[];
  for (const r of rows) {
    if (r.leg === "property") {
      if (r.account_id == null || !loanOfProperty.has(r.account_id)) {
        throw new Error(
          `depto ledger: loan_payments row of movement ${r.movement_id} (property leg) sits on account ${r.account_id}, which holds no property role`
        );
      }
      const loan = loanOfProperty.get(r.account_id);
      if (loan !== r.loan_account_id) {
        throw new Error(
          `depto ledger: loan_payments row of movement ${r.movement_id} names loan ${r.loan_account_id}, but property ${r.account_id}'s loan is ${loan ?? "none"}`
        );
      }
    } else {
      if (r.account_id == null || !propertyOfLoan.has(r.account_id)) {
        throw new Error(
          `depto ledger: loan_payments row of movement ${r.movement_id} (loan leg) sits on account ${r.account_id}, which is the loan of no property`
        );
      }
      if (r.account_id !== r.loan_account_id) {
        throw new Error(
          `depto ledger: loan_payments row of movement ${r.movement_id} sits on loan ${r.account_id} but names loan ${r.loan_account_id}`
        );
      }
    }
  }
}

/**
 * Rebuild one property's dividendos ledger (sorted by occurred_on, cuota — snapshot fns and
 * `defaultIncendioClpFromLedger` rely on the order) from the property account's movements: one
 * ledger per `property` role holder, its loan the account whose `loan_of` names it. Throws when
 * the account holds no property role, and when a `loan_payments` row anywhere sits on an account
 * the roles cannot place (data problem — fix data, not the loader).
 *
 * Memoized per property in the `depto_ledger` cache family — daily views price the property and
 * mortgage marks once per grid date, and the ledger rebuild dominated that cost. Dropped by every
 * valuation write the change log reports and at day rollover.
 */
export function loadDeptoLedgerForProperty(propertyAccountId: number): DeptoMortgageSheetRow[] {
  return getAggregationCached(cacheKeyDeptoLedger(propertyAccountId), () =>
    loadDeptoLedgerForPropertyUncached(propertyAccountId)
  );
}

/**
 * The depto ledger an account reads: its own when it is a property, its property's when it is
 * that property's loan; [] for any other account (no ledger models it).
 */
export function deptoLedgerForAccount(accountId: number): DeptoMortgageSheetRow[] {
  const propertyId = deptoPropertyIdOfAccount(accountId);
  return propertyId == null ? [] : loadDeptoLedgerForProperty(propertyId);
}

/** Every property's depto ledger with its pair (ascending by property id). */
export function loadAllDeptoLedgers(): (PropertyLoanPair & { rows: DeptoMortgageSheetRow[] })[] {
  const pairs = propertyLoanPairs();
  if (pairs.length === 0) {
    const stray = db.prepare(`SELECT COUNT(*) AS c FROM loan_payments`).get() as { c: number };
    if (stray.c > 0) {
      throw new Error(`depto ledger: ${stray.c} loan_payments rows exist but no account holds the property role`);
    }
    return [];
  }
  return pairs.map((p) => ({ ...p, rows: loadDeptoLedgerForProperty(p.propertyAccountId) }));
}

/** The depto ledger of the loan `loanAccountId` (its property's); throws when it is the loan of no property. */
export function deptoLedgerForLoan(loanAccountId: number): DeptoMortgageSheetRow[] {
  if (!accountHasRole(loanAccountId, "loan_of")) {
    throw new Error(`depto ledger: account ${loanAccountId} is the loan of no property (no loan_of role)`);
  }
  return deptoLedgerForAccount(loanAccountId);
}

function loadDeptoLedgerForPropertyUncached(propertyId: number): DeptoMortgageSheetRow[] {
  if (!accountHasRole(propertyId, "property")) {
    throw new Error(`depto ledger: account ${propertyId} holds no property role`);
  }
  assertLoanPaymentsPlaced(propertyLoanPairs());

  const movements = db
    .prepare(
      `SELECT p.*, m.occurred_on, m.amount, m.currency, m.counter_amount, m.counter_currency FROM movements m
       JOIN loan_payments p ON p.movement_id = m.id
       WHERE m.account_id = ? ORDER BY m.occurred_on, m.id`
    )
    .all(propertyId) as PropertyPaymentJoinRow[];
  if (movements.length === 0) return [];
  for (const m of movements) assertDeptoLoanPaymentCurrencies(m);

  const appraisals = propertyAppraisalsUfAsc(propertyId);
  if (appraisals.length === 0) {
    throw new Error(
      `depto ledger: the property account ${propertyId} has no appraisal (no UF valuations row) — net equity cannot be derived`
    );
  }
  const appraisalUfOnOrBefore = (ymd: string): number | null => {
    let v: number | null = null;
    for (const a of appraisals) {
      if (a.as_of_date > ymd) break;
      v = a.value_uf;
    }
    return v;
  };

  // Pass 1 — base rows from loan_payments (+ per-row uf_daily for derivations).
  const base: DeptoMortgageSheetRow[] = movements.map((m) => {
    const p = m;
    const ufDay = ufRowOnOrBefore(m.occurred_on)?.clp_per_uf ?? null;
    const pagoClp = Math.abs(movementClpLegOrZero(m));
    const cruf = p.balance_after ?? null;
    const restanteClp = cruf != null && ufDay != null ? Math.round(cruf * ufDay) : null;
    const viviendaUf = appraisalUfOnOrBefore(m.occurred_on);
    const vnuf = viviendaUf != null && cruf != null ? roundUf4(Math.max(0, viviendaUf - cruf)) : null;
    const amortClp = p.principal ?? null;
    const amortExtClp = p.extra_principal ?? null;
    const interesClp = p.interest ?? null;
    const amortUf = clpToUf4(amortClp, ufDay);
    const amortExtUf = amortExtClp != null && amortExtClp > 0 ? clpToUf4(amortExtClp, ufDay) : null;
    const interesUf = clpToUf4(interesClp, ufDay);
    const incendioClp = p.insurance_fire ?? null;
    const desgravamenClp = p.insurance_life ?? null;
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
      pago_clp: pagoClp,
      pago_uf: ufDay != null && ufDay > 0 ? roundUf5(pagoClp / ufDay) : null,
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
      valor_neto_clp: vnuf != null && ufDay != null ? Math.round(vnuf * ufDay) : null,
      pagado_neto_uf: null,
      delta_valor_neto_clp: null,
      valor_vivienda_uf: viviendaUf,
      valor_vivienda_clp:
        viviendaUf != null && ufDay != null ? Math.round(viviendaUf * ufDay) : null,
      min_uf: p.min_payment ?? null,
      max_uf: p.max_payment ?? null,
      incendio_clp: incendioClp,
      incendio_uf: incendioUf,
      desgravamen_clp: desgravamenClp,
      desgravamen_uf: desgravamenUf,
      total_seguros_uf: segurosUf,
      total_seguros_clp: segurosClp,
      seguros_interes_uf: sumPresent(roundUf5, segurosUf, interesUf),
      seguros_interes_clp: sumPresent(Math.round, segurosClp, interesClp),
      amortizacion_clp: amortClp,
      amortizacion_uf: amortUf,
      amortizacion_ext_clp: amortExtClp,
      amortizacion_ext_uf: amortExtUf,
      amortizacion_total_uf: sumPresent(roundUf5, amortUf, amortExtUf),
      amortizacion_total_clp: sumPresent(Math.round, amortClp, amortExtClp),
      interes_clp: interesClp,
      interes_uf: interesUf,
      prepayment_charge_clp: p.prepayment_charge ?? null,
      prepayment_charge_uf: clpToUf4(p.prepayment_charge ?? null, ufDay),
      delta_credito_amort_clp: null,
      interes_oculto_clp: null,
      interes_oculto_b_clp: null,
      interes_real_clp: null,
      interes_calculado_uf: null,
      amort_interes_text: null,
      pago_acumulado_clp: null,
      amort_acum_clp: null,
      interes_acum_clp: null,
    } satisfies DeptoMortgageSheetRow;
  });

  base.sort(deptoLedgerChronoCompare);
  assertDeptoPrepagoSequencing(base);

  // Pass 2 — consecutive deltas, cumsums, and recomputed analysis columns.
  const meta = mortgageAnalyticsMetaFromLedger(base);
  const balanceAfterPieUf = base.find((r) => isDeptoPieCuota(r.cuota))?.credito_restante_uf ?? null;
  let pagoAcum = 0;
  let amortAcum = 0;
  let interesAcum = 0;
  let anyAmort = false;
  let anyInteres = false;
  for (let i = 0; i < base.length; i++) {
    const row = base[i]!;
    const prior = i > 0 ? base[i - 1]! : null;
    pagoAcum += row.pago_clp;
    row.pago_acumulado_clp = Math.round(pagoAcum);
    row.pagado_neto_uf =
      balanceAfterPieUf != null && row.credito_restante_uf != null
        ? roundUf4(balanceAfterPieUf - row.credito_restante_uf)
        : null;
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
 * The depto property's or its loan's CLP mark at a calendar date: movement-ledger UF balance ×
 * `uf_daily` on or before `asOfYmd` (same math the sheet-based mark used). The account's profile
 * says which side of the ledger it is; any other account has no depto mark.
 */
export function deptoAccountMarkClpAtYmd(accountId: number, asOfYmd: string): DeptoAccountMarkAtYmd | null {
  const q = accountProfileOptional(accountId)?.quantity;
  if (q?.kind !== "depto_property" && q?.kind !== "depto_loan") return null;
  const categorySlug = q.kind === "depto_property" ? "property" : "mortgage";
  // The property whose ledger the account reads (its own, or the one its loan is of); a property
  // or loan the roles do not place has no depto ledger.
  const propertyId = q.propertyAccountId;
  if (propertyId == null || !accountHasRole(propertyId, "property")) return null;
  const ledger = loadDeptoLedgerForProperty(propertyId);
  if (!ledger.length) return null;
  const dates = [asOfYmd] as const;
  const ufMap = ufClpBySnapshotDatesAsc(dates);
  const closeBy =
    categorySlug === "property"
      ? deptoPropertyCloseClpBySnapshotDates(dates, ledger, ufMap)
      : deptoMortgageCloseClpBySnapshotDates(dates, ledger, ufMap);
  const clp = closeBy.get(asOfYmd);
  if (clp == null || !Number.isFinite(clp)) return null;
  return { value_clp: clp, as_of_date: asOfYmd };
}
