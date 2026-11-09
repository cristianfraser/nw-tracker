/**
 * The lender's own records against the ledger's loan payments (docs/untangle-flow-model.md A1, A3,
 * A4). Pure: the script (`scripts/cross-check-loan-payment-history.ts`) reads the documents and the
 * rows, this module compares and derives, the script writes.
 *
 * - {@link compareLoanPaymentHistory}: the lender's dividend history (one row per cuota: date paid,
 *   total, the parts) against the ledger's regular cuotas, field by field.
 * - {@link planCorrections}: what the user's plan says to write for each difference — the bank's
 *   figure, the bank's date, a cuota's unprinted interest as the residual of its total — and what
 *   it declares accepted. Anything else is reported only.
 * - {@link derivePrepagoSplit}: a prepago's split from the liquidation that was paid — principal,
 *   accrued interest and the prepayment charge (COMISIÓN DE PREPAGO + INTERÉS PENAL), by TOTAL A
 *   PAGAR in pesos; when the user paid a round figure instead, the principal is the ledger's balance
 *   drop × the liquidation's UF parity and the two liquidation lines stay as printed.
 * - {@link compareInterestCertificate}: Σ interest by payment month against the art. 55 bis
 *   certificate's monthly figures.
 */

export type BankCuotaRow = {
  cuota: string;
  paid_on: string;
  total_clp: number;
  principal_clp: number;
  extra_principal_clp: number;
  interest_clp: number;
  insurance_fire_clp: number;
  insurance_life_clp: number;
  /** Columns the ledger has no home for; anything above 0 is reported. */
  penalty_interest_clp: number;
  other_insurance_clp: number;
};

export type LedgerCuotaRow = {
  cuota: string;
  paid_on: string;
  total_clp: number;
  principal_clp: number | null;
  extra_principal_clp: number | null;
  interest_clp: number | null;
  insurance_fire_clp: number | null;
  insurance_life_clp: number | null;
};

export const COMPARED_FIELDS = [
  "paid_on",
  "total",
  "principal",
  "extra_principal",
  "interest",
  "insurance_fire",
  "insurance_life",
] as const;
export type ComparedField = (typeof COMPARED_FIELDS)[number];

/** A `loan_payments` column a correction may set. */
export type CorrectableField = Exclude<ComparedField, "paid_on" | "total">;

export type CuotaDifference = {
  cuota: string;
  field: ComparedField;
  bank: string | number;
  ledger: string | number | null;
};

export type HistoryComparison = {
  compared: number;
  agreeing: string[];
  differences: CuotaDifference[];
  /** Ledger cuotas the history does not list, and history cuotas the ledger lacks. */
  ledger_only: string[];
  bank_only: string[];
  /** History rows printing a penalty interest or other insurance (no home in the ledger). */
  unmodelled: { cuota: string; column: string; amount_clp: number }[];
};

function fieldOf(r: BankCuotaRow | LedgerCuotaRow, f: CorrectableField | "total"): number | null {
  switch (f) {
    case "total":
      return r.total_clp;
    case "principal":
      return r.principal_clp;
    case "extra_principal":
      return r.extra_principal_clp;
    case "interest":
      return r.interest_clp;
    case "insurance_fire":
      return r.insurance_fire_clp;
    case "insurance_life":
      return r.insurance_life_clp;
  }
}

/** The lender's rows (cuotas with a total above 0 — the grace months print zeros) against the ledger's regular cuotas. */
export function compareLoanPaymentHistory(bank: readonly BankCuotaRow[], ledger: readonly LedgerCuotaRow[]): HistoryComparison {
  const bankBy = new Map(bank.filter((b) => b.total_clp > 0).map((b) => [b.cuota, b]));
  const ledgerBy = new Map(ledger.map((l) => [l.cuota, l]));
  const out: HistoryComparison = { compared: 0, agreeing: [], differences: [], ledger_only: [], bank_only: [], unmodelled: [] };
  for (const [cuota, b] of bankBy) {
    if (b.penalty_interest_clp > 0) out.unmodelled.push({ cuota, column: "penalty_interest", amount_clp: b.penalty_interest_clp });
    if (b.other_insurance_clp > 0) out.unmodelled.push({ cuota, column: "other_insurance", amount_clp: b.other_insurance_clp });
    const l = ledgerBy.get(cuota);
    if (!l) {
      out.bank_only.push(cuota);
      continue;
    }
    out.compared += 1;
    let agrees = true;
    if (b.paid_on !== l.paid_on) {
      out.differences.push({ cuota, field: "paid_on", bank: b.paid_on, ledger: l.paid_on });
      agrees = false;
    }
    for (const f of ["total", "principal", "extra_principal", "interest", "insurance_fire", "insurance_life"] as const) {
      const bv = fieldOf(b, f) ?? 0;
      const lv = fieldOf(l, f);
      if (lv == null ? bv !== 0 : Math.round(lv) !== Math.round(bv)) {
        out.differences.push({ cuota, field: f, bank: bv, ledger: lv });
        agrees = false;
      }
    }
    if (agrees) out.agreeing.push(cuota);
  }
  for (const cuota of ledgerBy.keys()) if (!bankBy.has(cuota)) out.ledger_only.push(cuota);
  return out;
}

export type CorrectionPlanItem =
  | { kind: "set_field"; cuota: string; field: CorrectableField; source: "bank" }
  | { kind: "set_date"; cuota: string; source: "bank" }
  | { kind: "set_interest_residual"; cuota: string; reason?: string }
  | { kind: "accept"; cuota: string; field: string; reason: string };

export type Correction =
  | { cuota: string; kind: "set_field"; field: CorrectableField; from: number | null; to: number }
  | { cuota: string; kind: "set_date"; from: string; to: string }
  | { cuota: string; kind: "set_interest_residual"; from: number | null; to: number };

/**
 * The field names the mortgage sheet config (`accepted_differences`) uses for the same columns, so
 * one list serves the sheet import and this check.
 */
const SHEET_FIELD_ALIASES: Record<string, ComparedField> = {
  interes_clp: "interest",
  amortizacion_clp: "principal",
  amortizacion_ext_clp: "extra_principal",
  incendio_clp: "insurance_fire",
  desgravamen_clp: "insurance_life",
  pago_clp: "total",
};

export function normalizeAcceptedField(field: string): string {
  return SHEET_FIELD_ALIASES[field] ?? field;
}

export type CorrectionPlanResult = {
  corrections: Correction[];
  accepted: { cuota: string; field: string; reason: string }[];
  /** Differences the plan neither corrects nor accepts: reported, nothing written. */
  unplanned: CuotaDifference[];
};

/**
 * The plan's items against the comparison. A `set_field` takes the bank's figure for that cuota's
 * field (0 in the history = null in the ledger for the extra principal); `set_date` the bank's day;
 * `set_interest_residual` stores as interest what the bank's total leaves above its printed parts (the
 * first dividendo after the grace period: the lender prints the proportional interest outside its
 * Interés column). An item naming a cuota the history lacks, or a residual at or below 0, throws.
 */
export function planCorrections(
  comparison: HistoryComparison,
  bank: readonly BankCuotaRow[],
  ledger: readonly LedgerCuotaRow[],
  plan: readonly CorrectionPlanItem[]
): CorrectionPlanResult {
  const bankBy = new Map(bank.map((b) => [b.cuota, b]));
  const ledgerBy = new Map(ledger.map((l) => [l.cuota, l]));
  const out: CorrectionPlanResult = { corrections: [], accepted: [], unplanned: [] };
  const covered = new Set<string>();
  for (const item of plan) {
    const b = bankBy.get(item.cuota);
    const l = ledgerBy.get(item.cuota);
    if (item.kind === "accept") {
      out.accepted.push({ cuota: item.cuota, field: item.field, reason: item.reason });
      covered.add(`${item.cuota}|${normalizeAcceptedField(item.field)}`);
      continue;
    }
    if (!b || !l) throw new Error(`plan: cuota ${item.cuota} is not in both the history and the ledger`);
    if (item.kind === "set_field") {
      const to = fieldOf(b, item.field) ?? 0;
      const from = fieldOf(l, item.field);
      out.corrections.push({ cuota: item.cuota, kind: "set_field", field: item.field, from, to: Math.round(to) });
      covered.add(`${item.cuota}|${item.field}`);
    } else if (item.kind === "set_date") {
      out.corrections.push({ cuota: item.cuota, kind: "set_date", from: l.paid_on, to: b.paid_on });
      covered.add(`${item.cuota}|paid_on`);
    } else {
      const printed = b.principal_clp + b.extra_principal_clp + b.interest_clp + b.insurance_fire_clp + b.insurance_life_clp;
      const residual = b.total_clp - printed;
      if (residual <= 0) throw new Error(`plan: cuota ${item.cuota} has no residual above its printed parts (${residual})`);
      if (b.interest_clp !== 0) throw new Error(`plan: cuota ${item.cuota} prints interest ${b.interest_clp}; the residual rule is for a row printing none`);
      out.corrections.push({ cuota: item.cuota, kind: "set_interest_residual", from: l.interest_clp, to: residual });
      covered.add(`${item.cuota}|interest`);
    }
  }
  for (const d of comparison.differences) {
    if (!covered.has(`${d.cuota}|${d.field}`)) out.unplanned.push(d);
  }
  return out;
}

/** What a liquidation prints (pesos; UF where it matters). */
export type PrepagoLiquidation = {
  /** `Valores calculados al` */
  calculated_on: string;
  principal_uf: number;
  principal_clp: number;
  charge_clp: number;
  accrued_interest_clp: number;
  penalty_interest_clp: number;
  insurance_clp: number;
  total_clp: number;
  /** `Paridad`: pesos per UF the liquidation was priced at. */
  uf_parity: number;
  new_balance_uf: number;
  source: string;
};

export type PrepagoLedgerRow = {
  label: string;
  paid_on: string;
  total_clp: number;
  /** The balance before and after the prepago (UF), from the ledger's chronological order. */
  balance_before_uf: number;
  balance_after_uf: number;
};

export type PrepagoSplit = {
  label: string;
  liquidation: string;
  basis: "total_matches" | "round_payment";
  principal_clp: number;
  interest_clp: number;
  /** The lender's cost of prepaying (COMISIÓN DE PREPAGO + INTERÉS PENAL), never art. 55 bis interest. */
  prepayment_charge_clp: number;
  /** A round payment: the printed comisión + penal scaled like the interest, for the report (the charge above is the remainder). */
  printed_charge_scaled_clp: number | null;
};

/**
 * The liquidation a prepago paid: the one whose TOTAL A PAGAR equals the ledger's payment to the
 * peso (`total_matches`: every line as printed), else — the user paid a round figure and the lender
 * applied the difference to capital — the liquidation calculated closest before the payment
 * (`round_payment`): the principal is the ledger's balance drop × that liquidation's parity, the
 * accrued interest the printed one scaled to the principal actually prepaid (the lender's art. 55 bis
 * certificate confirms that figure to the peso), and the charge whatever the payment paid above both
 * (the printed comisión scaled the same way plus the rounding of the pesos). No liquidation calculated
 * on or before the payment throws; one whose insurance line is above 0 throws (a total prepayment).
 */
export function derivePrepagoSplit(row: PrepagoLedgerRow, liquidations: readonly PrepagoLiquidation[]): PrepagoSplit {
  const exact = liquidations.filter((q) => Math.round(q.total_clp) === Math.round(row.total_clp));
  if (exact.length > 1) throw new Error(`prepago ${row.label}: ${exact.length} liquidations total exactly its payment`);
  const total = Math.round(row.total_clp);
  if (exact.length === 1) {
    const q = exact[0]!;
    if (q.insurance_clp > 0) throw new Error(`prepago ${row.label}: liquidation ${q.source} charges insurance (a total prepayment?)`);
    const principal = Math.round(q.principal_clp);
    const interest = Math.round(q.accrued_interest_clp);
    const charge = Math.round(q.charge_clp + q.penalty_interest_clp);
    if (principal + interest + charge !== total) {
      throw new Error(`prepago ${row.label}: liquidation ${q.source} totals the payment but its lines add up to ${principal + interest + charge}`);
    }
    return { label: row.label, liquidation: q.source, basis: "total_matches", principal_clp: principal, interest_clp: interest, prepayment_charge_clp: charge, printed_charge_scaled_clp: null };
  }
  const before = liquidations
    .filter((q) => q.calculated_on <= row.paid_on)
    .sort((a, b) => b.calculated_on.localeCompare(a.calculated_on));
  const q = before[0];
  if (!q) throw new Error(`prepago ${row.label} (${row.paid_on}): no liquidation calculated on or before it`);
  if (q.insurance_clp > 0) throw new Error(`prepago ${row.label}: liquidation ${q.source} charges insurance (a total prepayment?)`);
  const dropUf = row.balance_before_uf - row.balance_after_uf;
  if (!(dropUf > 0)) throw new Error(`prepago ${row.label}: the balance did not drop (${row.balance_before_uf} → ${row.balance_after_uf})`);
  if (!(q.principal_uf > 0)) throw new Error(`prepago ${row.label}: liquidation ${q.source} prints no principal in UF`);
  const ratio = dropUf / q.principal_uf;
  const principal = Math.round(dropUf * q.uf_parity);
  const interest = Math.round(q.accrued_interest_clp * ratio);
  const charge = total - principal - interest;
  if (charge <= 0) throw new Error(`prepago ${row.label}: the payment (${total}) does not cover principal ${principal} + interest ${interest}`);
  return {
    label: row.label,
    liquidation: q.source,
    basis: "round_payment",
    principal_clp: principal,
    interest_clp: interest,
    prepayment_charge_clp: charge,
    printed_charge_scaled_clp: Math.round((q.charge_clp + q.penalty_interest_clp) * ratio),
  };
}

/**
 * `pdftotext -layout` of a liquidation → its figures. The lender prints one document in Chilean
 * digit grouping («14.093.871», «370,6938») and another in US («11,930,001», «299.5630»); a lone
 * «8,008» is ambiguous on its own, so the style is decided once per document from a token that is
 * not — two groups of three, or a UF figure with four decimals — and every number read in it.
 */
export function parsePrepagoLiquidation(text: string, source: string): PrepagoLiquidation {
  const chilean = /\d{1,3}(\.\d{3}){2,}|\d,\d{4}\b/.test(text);
  const us = /\d{1,3}(,\d{3}){2,}|\d\.\d{4}\b/.test(text);
  if (chilean === us) throw new Error(`liquidation ${source}: cannot tell the digit grouping (${chilean ? "both styles" : "neither style"} present)`);
  const num = (raw: string): number => {
    const t = raw.trim();
    const ok = chilean ? /^\d{1,3}(\.\d{3})*(,\d+)?$/.test(t) : /^\d{1,3}(,\d{3})*(\.\d+)?$/.test(t);
    if (!ok) throw new Error(`liquidation ${source}: cannot read the number «${raw}»`);
    return chilean ? Number(t.replace(/\./g, "").replace(",", ".")) : Number(t.replace(/,/g, ""));
  };
  const line = (label: string): { uf: number; clp: number } => {
    const m = text.match(new RegExp(`^\\s*${label}\\s+([\\d.,]+)\\s+([\\d.,]+)\\s*$`, "m"));
    if (!m) throw new Error(`liquidation ${source}: no «${label}» line`);
    return { uf: num(m[1]!), clp: num(m[2]!) };
  };
  const one = (label: string): string => {
    const m = text.match(new RegExp(`${label}\\s*:?\\s*([\\d.,/]+)`, "m"));
    if (!m) throw new Error(`liquidation ${source}: no «${label}»`);
    return m[1]!;
  };
  const principal = line("MONTO DE PREPAGO A CAPITAL");
  const charge = line("COMISION DE PREPAGO");
  const interest = line("INTERES DEVENGADO");
  const insurance = line("SEGUROS MES PREPAGO");
  const penalty = line("INTERES PENAL DIV\\.");
  const total = line("TOTAL A PAGAR");
  const calc = one("Valores calculados al").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!calc) throw new Error(`liquidation ${source}: cannot read «Valores calculados al»`);
  const balance = text.match(/NUEVO SALDO ACTUAL EN MONEDA ORIGEN:\s*([\d.,]+)\s*UF/);
  if (!balance) throw new Error(`liquidation ${source}: no new balance`);
  return {
    calculated_on: `${calc[3]}-${calc[2]}-${calc[1]}`,
    principal_uf: principal.uf,
    principal_clp: principal.clp,
    charge_clp: charge.clp,
    accrued_interest_clp: interest.clp,
    penalty_interest_clp: penalty.clp,
    insurance_clp: insurance.clp,
    total_clp: total.clp,
    uf_parity: num(one("Paridad")),
    new_balance_uf: num(balance[1]!),
    source,
  };
}

export type CertificateMonth = { month: string; interest_clp: number };

const SPANISH_MONTHS: Record<string, string> = {
  enero: "01", febrero: "02", marzo: "03", abril: "04", mayo: "05", junio: "06",
  julio: "07", agosto: "08", septiembre: "09", octubre: "10", noviembre: "11", diciembre: "12",
};

/**
 * `pdftotext -layout` of the lender's art. 55 bis certificate: the year it covers and, per payment
 * month, the nominal interest paid. The month lines read «Febrero 900.276 1,0260 923.683»
 * (the first names its year: «Enero 2025 0 1,0360 0»); the Totales line must equal their sum.
 */
export function parseInterestCertificate(text: string): { year: number; months: CertificateMonth[] } {
  const yearMatch = text.match(/durante el a[ñn]o\s+(\d{4})/i);
  if (!yearMatch) throw new Error("certificate: no «durante el año <year>»");
  const year = Number(yearMatch[1]);
  const months: CertificateMonth[] = [];
  let total: number | null = null;
  for (const raw of text.split("\n")) {
    const m = raw.match(/^\s*([A-Za-zñÑ]+)(?:\s+(\d{4}))?\s+([\d.]+)\s+[\d,]+\s+[\d.]+\s*$/);
    if (m) {
      const mm = SPANISH_MONTHS[m[1]!.toLowerCase()];
      if (!mm) continue;
      if (m[2] && Number(m[2]) !== year) throw new Error(`certificate: month ${m[1]} names year ${m[2]}, certificate ${year}`);
      months.push({ month: `${year}-${mm}`, interest_clp: Number(m[3]!.replace(/\./g, "")) });
      continue;
    }
    const t = raw.match(/^\s*Totales\s+([\d.]+)\s+[\d.]+\s*$/);
    if (t) total = Number(t[1]!.replace(/\./g, ""));
  }
  if (months.length !== 12) throw new Error(`certificate: read ${months.length} month lines, expected 12`);
  if (total == null) throw new Error("certificate: no Totales line");
  const sum = months.reduce((s, m) => s + m.interest_clp, 0);
  if (sum !== total) throw new Error(`certificate: the months add up to ${sum}, the Totales line prints ${total}`);
  return { year, months };
}

export type InterestByMonth = { month: string; interest_clp: number };

/** Σ interest by payment month (the ledger side: cuotas' interest + prepagos' accrued interest, never the prepayment charge). */
export function interestByPaymentMonth(payments: readonly { paid_on: string; interest_clp: number | null }[], year: number): InterestByMonth[] {
  const by = new Map<string, number>();
  for (let m = 1; m <= 12; m++) by.set(`${year}-${String(m).padStart(2, "0")}`, 0);
  for (const p of payments) {
    const month = p.paid_on.slice(0, 7);
    if (!by.has(month)) continue;
    by.set(month, by.get(month)! + Math.round(p.interest_clp ?? 0));
  }
  return [...by].map(([month, interest_clp]) => ({ month, interest_clp }));
}

export function compareInterestCertificate(
  certificate: readonly CertificateMonth[],
  ledger: readonly InterestByMonth[]
): { agreeing: number; differences: { month: string; certificate_clp: number; ledger_clp: number }[] } {
  const ledgerBy = new Map(ledger.map((l) => [l.month, l.interest_clp]));
  let agreeing = 0;
  const differences: { month: string; certificate_clp: number; ledger_clp: number }[] = [];
  for (const c of certificate) {
    const l = ledgerBy.get(c.month) ?? 0;
    if (l === c.interest_clp) agreeing += 1;
    else differences.push({ month: c.month, certificate_clp: c.interest_clp, ledger_clp: l });
  }
  return { agreeing, differences };
}
