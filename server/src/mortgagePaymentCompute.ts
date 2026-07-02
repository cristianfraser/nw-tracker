import {
  type DeptoMortgageSheetRow,
  isDeptoMortgagePaymentCuota,
} from "./deptoDividendosLedger.js";
import {
  computeMortgagePaymentAnalytics,
  mortgageAnalyticsMetaFromLedger,
  roundUf4,
} from "./mortgagePaymentAnalytics.js";
import { computeMortgageScenarioPaymentUf } from "./mortgageScenarioPayments.js";
import { ufRowOnOrBefore } from "./fxRates.js";
import type { MortgagePaymentInput } from "./mortgagePaymentTypes.js";

export type { MortgagePaymentInput } from "./mortgagePaymentTypes.js";

/** Calibrated from recent Suecia cuotas: desgravamen_clp ≈ balance_before_clp × rate. */
export const DESGRAVAMEN_CLP_PER_CLP_BALANCE = 0.00003961;

const TERM_30_PLAZO_MESES = 360;
const PAYMENT_RECONCILE_TOLERANCE_CLP = 1;

export type MortgagePaymentComputeResult = {
  sheet: DeptoMortgageSheetRow;
  input: MortgagePaymentInput;
  desgravamen_default_clp: number;
  desgravamen_used_override: boolean;
};

function roundUf5(v: number): number {
  return Math.round(v * 1e5) / 1e5;
}

function clpToUfPago(clp: number, ufClpDay: number): number {
  return roundUf5(clp / ufClpDay);
}

function clpToUf(clp: number, ufClpDay: number): number {
  return roundUf4(clp / ufClpDay);
}

function splitAmortFromMinPayment(
  pago_clp: number,
  interes_clp: number,
  incendio_clp: number,
  desgravamen_clp: number,
  min_uf: number,
  total_seguros_uf: number,
  uf_clp_day: number
): { amortizacion_clp: number; amortizacion_ext_clp: number } {
  const interesUf = roundUf4(interes_clp / uf_clp_day);
  const scheduledAmortUf = roundUf4(min_uf - total_seguros_uf - interesUf);
  if (scheduledAmortUf < 0) {
    throw new Error(
      `Negative scheduled amortización UF from min payment: min ${min_uf} − seguros ${total_seguros_uf} − interés ${interesUf}`
    );
  }
  const amortizacion_clp = Math.round(scheduledAmortUf * uf_clp_day);
  const amortizacion_ext_clp =
    pago_clp - interes_clp - incendio_clp - desgravamen_clp - amortizacion_clp;
  if (amortizacion_ext_clp < 0) {
    throw new Error(
      `Payment too small for scheduled cuota: prepago would be ${amortizacion_ext_clp} CLP after amort ${amortizacion_clp}`
    );
  }
  return { amortizacion_clp, amortizacion_ext_clp };
}

function requireYmd(occurredOn: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(occurredOn.trim())) {
    throw new Error(`Invalid occurred_on: ${occurredOn} (expected YYYY-MM-DD)`);
  }
}

function numericCuota(cuota: string): number | null {
  const n = parseInt(String(cuota).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function suggestNextMortgageCuota(ledger: readonly DeptoMortgageSheetRow[]): string {
  let max = 0;
  for (const row of ledger) {
    const n = numericCuota(row.cuota);
    if (n != null && n > max) max = n;
  }
  return String(max + 1);
}

export function defaultIncendioClpFromLedger(ledger: readonly DeptoMortgageSheetRow[]): number | null {
  for (let i = ledger.length - 1; i >= 0; i--) {
    const v = ledger[i]!.incendio_clp;
    if (v != null && Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

export function defaultDesgravamenClp(balanceBeforeUf: number, ufClpDay: number): number {
  if (!Number.isFinite(balanceBeforeUf) || balanceBeforeUf <= 0) {
    throw new Error("Cannot compute desgravamen: invalid balance-before UF");
  }
  if (!Number.isFinite(ufClpDay) || ufClpDay <= 0) {
    throw new Error("Cannot compute desgravamen: invalid UF día");
  }
  return Math.round(balanceBeforeUf * ufClpDay * DESGRAVAMEN_CLP_PER_CLP_BALANCE);
}

function priorMortgagePaymentRow(
  ledger: readonly DeptoMortgageSheetRow[],
  occurredOn: string,
  cuota: string
): DeptoMortgageSheetRow | null {
  const sorted = [...ledger].sort((a, b) => sortSheetRows(a, b));
  let prior: DeptoMortgageSheetRow | null = null;
  for (const row of sorted) {
    if (row.cuota === cuota && row.occurred_on === occurredOn) {
      throw new Error(`Mortgage payment already exists for cuota ${cuota} on ${occurredOn}`);
    }
    if (
      row.occurred_on < occurredOn ||
      (row.occurred_on === occurredOn && row.cuota.localeCompare(cuota) < 0)
    ) {
      prior = row;
    } else {
      break;
    }
  }
  return prior;
}

function sortSheetRows(a: DeptoMortgageSheetRow, b: DeptoMortgageSheetRow): number {
  const c = a.occurred_on.localeCompare(b.occurred_on);
  return c !== 0 ? c : a.cuota.localeCompare(b.cuota);
}

function monthsPaidBeforeCuota(ledger: readonly DeptoMortgageSheetRow[], cuotaNum: number): number {
  let n = 0;
  for (const row of ledger) {
    const num = numericCuota(row.cuota);
    if (num != null && num < cuotaNum && isDeptoMortgagePaymentCuota(row.cuota)) n += 1;
  }
  return n;
}

export function computeMortgagePaymentRow(
  ledger: readonly DeptoMortgageSheetRow[],
  rawInput: MortgagePaymentInput
): MortgagePaymentComputeResult {
  requireYmd(rawInput.occurred_on);
  const occurred_on = rawInput.occurred_on.trim();

  const pago_clp = rawInput.pago_clp;
  const interes_clp = rawInput.interes_clp;
  const incendio_clp = rawInput.incendio_clp;
  const explicitAmortExt =
    rawInput.amortizacion_ext_clp != null && Number.isFinite(rawInput.amortizacion_ext_clp);

  if (!Number.isFinite(pago_clp) || pago_clp <= 0) {
    throw new Error("pago_clp must be a positive number");
  }
  if (!Number.isFinite(interes_clp) || interes_clp < 0) {
    throw new Error("interes_clp must be a non-negative number");
  }
  if (!Number.isFinite(incendio_clp) || incendio_clp < 0) {
    throw new Error("incendio_clp must be a non-negative number");
  }
  if (explicitAmortExt && rawInput.amortizacion_ext_clp! < 0) {
    throw new Error("amortizacion_ext_clp must be a non-negative number");
  }

  const cuota = (rawInput.cuota?.trim() || suggestNextMortgageCuota(ledger)).trim();
  if (!cuota) throw new Error("cuota is required");

  const prior = priorMortgagePaymentRow(ledger, occurred_on, cuota);
  const balanceBeforeUf = prior?.credito_restante_uf;
  if (balanceBeforeUf == null || !Number.isFinite(balanceBeforeUf)) {
    throw new Error(
      "Cannot compute payment: no prior crédito restante UF in ledger (log payments in order)"
    );
  }

  const ufRow = ufRowOnOrBefore(occurred_on);
  if (!ufRow?.clp_per_uf || !Number.isFinite(ufRow.clp_per_uf)) {
    throw new Error(`No UF rate in uf_daily on or before ${occurred_on}`);
  }
  const uf_clp_day = ufRow.clp_per_uf;

  const desgravamen_default_clp = defaultDesgravamenClp(balanceBeforeUf, uf_clp_day);
  const desgravamen_used_override =
    rawInput.desgravamen_clp != null && Number.isFinite(rawInput.desgravamen_clp);
  const desgravamen_clp = desgravamen_used_override
    ? Math.round(rawInput.desgravamen_clp!)
    : desgravamen_default_clp;

  if (desgravamen_clp < 0) throw new Error("desgravamen_clp must be non-negative");

  const incendio_uf = clpToUf(incendio_clp, uf_clp_day);
  const desgravamen_uf = clpToUf(desgravamen_clp, uf_clp_day);
  const total_seguros_clp = incendio_clp + desgravamen_clp;
  const total_seguros_uf = roundUf4(incendio_uf + desgravamen_uf);

  const cuotaNum = numericCuota(cuota);
  const paymentNum = cuotaNum ?? monthsPaidBeforeCuota(ledger, cuotaNum ?? 0) + 1;
  const min_uf =
    computeMortgageScenarioPaymentUf(
      balanceBeforeUf,
      TERM_30_PLAZO_MESES,
      paymentNum,
      total_seguros_uf
    ) ?? null;

  let amortizacion_clp: number;
  let amortizacion_ext_clp: number;
  if (explicitAmortExt) {
    amortizacion_ext_clp = Math.round(rawInput.amortizacion_ext_clp!);
    amortizacion_clp =
      pago_clp - interes_clp - incendio_clp - desgravamen_clp - amortizacion_ext_clp;
    if (amortizacion_clp < 0) {
      throw new Error(
        `Negative amortización: pago ${pago_clp} − interés ${interes_clp} − incendio ${incendio_clp} − desgravamen ${desgravamen_clp} − prepago ${amortizacion_ext_clp} = ${amortizacion_clp}`
      );
    }
  } else {
    if (min_uf == null) {
      throw new Error("Cannot split amortización: min UF payment unavailable");
    }
    const split = splitAmortFromMinPayment(
      pago_clp,
      interes_clp,
      incendio_clp,
      desgravamen_clp,
      min_uf,
      total_seguros_uf,
      uf_clp_day
    );
    amortizacion_clp = split.amortizacion_clp;
    amortizacion_ext_clp = split.amortizacion_ext_clp;
  }

  const componentSum =
    interes_clp + incendio_clp + desgravamen_clp + amortizacion_clp + amortizacion_ext_clp;
  if (Math.abs(componentSum - pago_clp) > PAYMENT_RECONCILE_TOLERANCE_CLP) {
    throw new Error(
      `Payment components (${componentSum}) do not match pago_clp (${pago_clp}) within ±${PAYMENT_RECONCILE_TOLERANCE_CLP} CLP`
    );
  }

  const interes_uf = clpToUf(interes_clp, uf_clp_day);
  const amortizacion_uf = clpToUf(amortizacion_clp, uf_clp_day);
  const amortizacion_ext_uf =
    amortizacion_ext_clp > 0 ? clpToUf(amortizacion_ext_clp, uf_clp_day) : null;
  const pago_uf = clpToUfPago(pago_clp, uf_clp_day);

  const credito_restante_uf = roundUf4(
    balanceBeforeUf - amortizacion_uf - (amortizacion_ext_uf ?? 0)
  );
  if (credito_restante_uf < 0) {
    throw new Error(`Negative crédito restante UF after payment: ${credito_restante_uf}`);
  }

  // Gross value derived from the prior ledger row (vnuf + cruf ≡ valor vivienda) — no
  // hardcoded tasación, so any tracked property works. Fail fast when underivable.
  const grossUf =
    prior?.valor_neto_uf != null && prior?.credito_restante_uf != null
      ? roundUf4(prior.valor_neto_uf + prior.credito_restante_uf)
      : null;
  if (grossUf == null) {
    throw new Error(
      "Cannot derive valor vivienda UF: prior ledger row lacks valor_neto_uf/credito_restante_uf"
    );
  }
  const valor_neto_uf = roundUf4(Math.max(0, grossUf - credito_restante_uf));
  const restante_clp = Math.round(credito_restante_uf * uf_clp_day);
  const valor_neto_clp = Math.round(valor_neto_uf * uf_clp_day);
  const valor_vivienda_clp = Math.round(grossUf * uf_clp_day);

  const priorRestanteClp = prior?.restante_clp ?? Math.round(balanceBeforeUf * uf_clp_day);
  const priorValorNetoClp = prior?.valor_neto_clp ?? null;
  const priorPagadoNetoUf = prior?.pagado_neto_uf ?? 0;
  const priorPagoAcum = prior?.pago_acumulado_clp ?? 0;
  const priorAmortAcum = prior?.amort_acum_clp ?? 0;
  const priorInteresAcum = prior?.interes_acum_clp ?? 0;

  const pagado_neto_uf = roundUf4(
    priorPagadoNetoUf + amortizacion_uf + (amortizacion_ext_uf ?? 0)
  );
  const pago_acumulado_clp = priorPagoAcum + pago_clp;
  const amort_acum_clp = priorAmortAcum + amortizacion_clp + amortizacion_ext_clp;
  const interes_acum_clp = priorInteresAcum + interes_clp;

  const input: MortgagePaymentInput = {
    occurred_on,
    pago_clp,
    interes_clp,
    incendio_clp,
    desgravamen_clp,
    cuota,
    amortizacion_ext_clp: amortizacion_ext_clp > 0 ? amortizacion_ext_clp : null,
  };

  const sheetBase: DeptoMortgageSheetRow = {
    cuota,
    occurred_on,
    pago_clp,
    pago_uf,
    pct_dividendo: null,
    uf_clp_day,
    mm_pct: null,
    yy_pct: null,
    tasa_plus: null,
    credito_restante_uf,
    pct_credito_uf: null,
    restante_clp,
    pct_de_total: null,
    delta_credito_clp: restante_clp - priorRestanteClp,
    valor_neto_uf,
    valor_neto_clp,
    pagado_neto_uf,
    delta_valor_neto_clp:
      priorValorNetoClp != null ? valor_neto_clp - priorValorNetoClp : null,
    valor_vivienda_uf: grossUf,
    valor_vivienda_clp,
    min_uf,
    incendio_clp,
    incendio_uf,
    desgravamen_clp,
    desgravamen_uf,
    total_seguros_uf,
    total_seguros_clp,
    amortizacion_clp,
    amortizacion_uf,
    amortizacion_ext_clp: amortizacion_ext_clp > 0 ? amortizacion_ext_clp : null,
    amortizacion_ext_uf,
    interes_clp,
    interes_uf,
    delta_credito_amort_clp: null,
    interes_oculto_clp: null,
    interes_oculto_b_clp: null,
    interes_real_clp: null,
    interes_calculado_uf: null,
    amort_interes_text: null,
    pago_acumulado_clp,
    amort_acum_clp,
    interes_acum_clp,
  };

  const analyticsMeta = mortgageAnalyticsMetaFromLedger(ledger);
  const analytics = computeMortgagePaymentAnalytics(
    sheetBase,
    prior,
    [...ledger, sheetBase],
    analyticsMeta
  );
  const sheet: DeptoMortgageSheetRow = { ...sheetBase, ...analytics };

  return {
    sheet,
    input,
    desgravamen_default_clp,
    desgravamen_used_override,
  };
}
