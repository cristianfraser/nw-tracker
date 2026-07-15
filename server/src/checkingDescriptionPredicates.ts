/**
 * Pure cartola description / note classifiers for the checking gastos + deposit-matching
 * engine (`flowsCheckingGastos.ts`). Everything here is string-in → verdict-out — no DB
 * access, no matching state. The engine and its loaders import from this module; keeping
 * the predicate layer separate makes the classification rules independently testable and
 * keeps regex knowledge out of the matcher.
 */
import { isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import {
  isCheckingPartialWithdrawalNote,
  parsePartialMovementNote,
} from "./checkingCartolaPartialReconcile.js";
import { stripTrailingCartolaNoteTags } from "./checkingCartolaParse.js";
import {
  isGenericTransferMerchantKey,
  normalizeCcExpenseMerchantKey,
} from "./ccExpenseCategories.js";
import { isExactGenericUniqueMerchantKey } from "./ccExpenseGenericUniqueMerchants.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";

/** Asset group for cash / efectivo accounts (internal transfer targets from checking). */
export const CHECKING_GASTOS_CASH_GROUP = "cash_eqs";

export function stripCheckingBranchPrefix(description: string): string {
  const trimmed = description.trim();
  const m = trimmed.match(
    /^(?:\S+\s+)*((?:Transf|Traspaso|Giro|Egreso|COMPRA|TRANSF|TRASPASO|GIRO).*)$/i
  );
  return m?.[1] ?? trimmed;
}

/** ATM cash withdrawals must not pair with internal deposit inflows. */
export function checkingOutflowIsAtmWithdrawal(description: string): boolean {
  const key = normalizeCcExpenseMerchantKey(stripCheckingBranchPrefix(description));
  return /^GIRO\s+(?:EN\s+)?CAJERO|^GIRO\s+POR\s+CAJAS/.test(key);
}

const INVESTMENT_DEPOSIT_GROUPS = new Set(["real_estate", "brokerage", "retirement"]);

export function isInvestmentDepositTarget(groupSlug: string): boolean {
  return INVESTMENT_DEPOSIT_GROUPS.has(groupSlug);
}

export function isCheckingGastosWithdrawalNote(note: string | null | undefined): boolean {
  const n = String(note ?? "").trim();
  if (!n || isCheckingLedgerAnchorNote(n)) return false;
  return n.startsWith("import:cartola|") || isCheckingPartialWithdrawalNote(n);
}

export const INTERNAL_TRANSFER_RE = /CRISTIAN\s+FRASER\s*-\s*SANTANDER/i;
export const CC_PAYMENT_DESC_RE =
  /MONTO\s+CANCELADO|PAGO\s+.*TARJETA|TARJETA\s+DE\s+CR[EÉ]DITO|PAGO\s+TARJETA|TRASPASO(?:\s+\w+)*\s+A\s+T\.?\s*CR[EÉ]DITO|TRASPASO(?:\s+\w+)*\s+A\s+L[IÍ]NEA\s+CR[EÉ]DITO|(?:EGRESO\s+POR\s+)?COMPRA\s+DE\s+DIVISAS/i;
/** Own Santander account transfers (not spending). */
export const OWN_SANTANDER_TRANSFER_RE = /TRASPASO(?:\s+\w+)*\s+A\s+CUENTAM[AÁ]TICA/i;
/** Transfers to cuenta vista (CUENTAMATICA / vale vista), e.g. AFP 10% retiros. */
export const CUENTA_VISTA_TRANSFER_DESC_RE =
  /TRASPASO(?:\s+\w+)*\s+A\s+CUENTA\s+VISTA/i;
/** Transfers to Fondo reserva (internal, not consumption). */
export const RESERVA_TRANSFER_DESC_RE =
  /\bRESERVA\b|FONDO\s+RESERVA|TRASPASO(?:\s+\w+)*\s+A\s+.*\bRESERVA\b|DEP[OÓ]SITO(?:\s+\w+)*\s+A\s+.*\bRESERVA\b/i;

/** Direct "FINTUAL ADMINISTRADORA" wires — excluded from the gastos list outright. Kept narrow so
 *  "TRASPASO A FINTUAL" / "Transf a Fintual" stay OUT of the exclusion set and flow through the
 *  gastos matcher instead (see the excludes-internal-transfer test). */
export const FINTUAL_TRANSFER_DESC_RE = /FINTUAL\s+ADMINISTRADORA/i;

/** Any transfer mentioning Fintual (Transf a Fintual, PAC FINTUAL, FINTUAL ADMINISTRADORA) is
 *  investment funding — used for auto-matching a withdrawal to a Fintual deposit. Broader than the
 *  exclusion regex; safe because the deposit pairing still requires an exact amount + date match. */
export const FINTUAL_INVESTMENT_TRANSFER_RE = /\bFINTUAL\b/i;

/** Incoming checking abono from Fintual (capital return from net-worth accounts). */
export const FINTUAL_INCOMING_TRANSFER_RE = /\bFINTUAL\b/i;

/** Buda.com crypto exchange wires into checking (sale proceeds, not salary / external income). */
export const BUDA_CRYPTO_EXCHANGE_TRANSFER_RE = /\bTRANSF\.?\s+.*\bBUDA\b/i;

/** AFP 10% retiro proceeds wired into checking (not external income). */
export const AFP_CHECKING_INFLOW_DESC_RE = /\bABONO\s+10\s*%\s*AFP\b|\bANTI\s+PREV\s+AFP\b/i;

/** Employer payroll deposits (REMUNERACION) — real income even when swept to vista same day. */
export const PAYROLL_REMUNERACION_INFLOW_RE = /\bREMUNERACION(?:ES)?\b/i;

/** ATM / branch cash deposit on cartola (often cuenta ahorro month-end retiro proceeds). */
// Cash-style deposits into checking that book a cuenta_ahorro (or similar month-bucket) withdrawal
// returning to the account: "Depósito en Efectivo", "Depósito con Vales Vista", "… con Cheque".
export const CHECKING_CASH_DEPOSIT_INFLOW_RE =
  /DEP[OÓ]SITO\s+(?:EN\s+EFECTIVO|CON\s+(?:VALES?\s+VISTA|CHEQUES?))/i;

export function isPayrollRemuneracionCheckingInflow(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  return PAYROLL_REMUNERACION_INFLOW_RE.test(d);
}

/** Payroll deposit on cartola — REMUNERACION may live in branch or description segment of the note. */
export function isPayrollRemuneracionCartolaCredit(credit: {
  note: string | null;
}): boolean {
  const n = String(credit.note ?? "").trim();
  if (PAYROLL_REMUNERACION_INFLOW_RE.test(n)) return true;
  return isPayrollRemuneracionCheckingInflow(cartolaDescriptionFromNote(credit.note));
}

/** Vista ↔ corriente internet traspaso (both directions on cartola). */
export const CHECKING_CORRIENTE_INTERNET_TRANSFER_RE =
  /TRASPASO\s+INTERNET\s+(?:A\s+CTA\.?\s*CTE?\.?|DESDE\s+CTA\.?\s*CT\.?|(?:DE|A)\s+CUENTA\s+VISTA)/i;

/** Vista (or checking) outflow wiring money to cuenta corriente — always an internal move. */
export const CHECKING_CORRIENTE_VISTA_TRASPASO_OUTFLOW_RE =
  /TRASPASO\s+INTERNET\s+A\s+CTA\.?\s*CTE?\.?/i;

export function isCheckingCorrienteVistaTraspasoOutflow(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  return CHECKING_CORRIENTE_VISTA_TRASPASO_OUTFLOW_RE.test(d);
}

/** Only generic internal-transfer cartola descriptions may auto-pair with deposit inflows. */
export function checkingWithdrawalMayAutoMatchDeposit(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  if (!d) return false;
  if (isCheckingCorrienteVistaTraspasoOutflow(d)) return true;
  if (INTERNAL_TRANSFER_RE.test(d)) return true;
  if (CUENTA_VISTA_TRANSFER_DESC_RE.test(d)) return true;
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_INVESTMENT_TRANSFER_RE.test(d)) return true;
  const merchantKey = normalizeCcExpenseMerchantKey(d);
  if (isExactGenericUniqueMerchantKey(merchantKey)) return true;
  if (isGenericTransferMerchantKey(merchantKey)) return true;
  return false;
}

/** Santander capital-markets money order charge (downpayment rail). */
export const MERCADO_CAPITALES_CARGO_RE = /Cargo\s+Mercado\s+Capitales/i;
/** Long numeric cartola reference used for the same money-order rail. */
export const LONG_NUMERIC_CARGO_REF_RE = /^\d{10,}$/;

/** DAP refund when a money order was annulled or a DAP matured (paired with cargo by `doc:`). */
export const DAP_ABONADO_RE = /\bDAP\s+(\d+)\s+ABONADO\b/i;
/** Cuenta vista return of a DAP placed via Mercado Capitales (vale vista collection). */
export const COBRO_VVISTA_DAP_RE = /\bCOBRO\s+VVISTA\s+(\d+)/i;

/** Max days between MC cargo and matching DAP ABONADO credit (12 months). */
export const DAP_ABONO_MAX_DAY_GAP = 365;

/** Min premium on short DAP maturities (e.g. 42-day ~0.49% on Aug 2024 doc 9204418). */
export const DAP_ABONO_MIN_PREMIUM_RATIO = 0.01;

/** Max premium at {@link DAP_ABONO_MAX_DAY_GAP} (longer DAP terms). */
export const DAP_ABONO_MAX_PREMIUM_RATIO = 0.1;

/** Abono `doc:` may be cargo doc + N (Santander cartola numbering). */
export const DAP_ABONO_DOC_SPREAD = 2;

export function checkingCreditLooksLikeMonthBucketCashReturn(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  if (!d) return false;
  if (isPayrollRemuneracionCheckingInflow(d)) return false;
  return CHECKING_CASH_DEPOSIT_INFLOW_RE.test(d);
}

export function daysBetweenYmd(a: string, b: string): number {
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 999;
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

export function signedDaysFromTo(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 999;
  return Math.round((to - from) / 86_400_000);
}

export function dapReferenceFromDescription(description: string): string | null {
  const d = description.trim();
  const abono = DAP_ABONADO_RE.exec(d);
  if (abono?.[1]) return abono[1];
  const vv = COBRO_VVISTA_DAP_RE.exec(d);
  return vv?.[1] ?? null;
}

export function cartolaDocsMatchForDapAbono(cargoDoc: string, creditDoc: string | null, dapRef: string | null): boolean {
  if (creditDoc === cargoDoc) return true;
  if (creditDoc != null) {
    const cargoNum = Number.parseInt(cargoDoc, 10);
    const creditNum = Number.parseInt(creditDoc, 10);
    if (
      Number.isFinite(cargoNum) &&
      Number.isFinite(creditNum) &&
      creditNum >= cargoNum &&
      creditNum <= cargoNum + DAP_ABONO_DOC_SPREAD
    ) {
      return true;
    }
  }
  if (dapRef != null && (dapRef.endsWith(cargoDoc) || dapRef.includes(cargoDoc))) return true;
  return false;
}

function dapAbonoMaxPremiumRatioForDayGap(dayGap: number): number {
  const clamped = Math.max(0, Math.min(dayGap, DAP_ABONO_MAX_DAY_GAP));
  const t = clamped / DAP_ABONO_MAX_DAY_GAP;
  return DAP_ABONO_MIN_PREMIUM_RATIO + t * (DAP_ABONO_MAX_PREMIUM_RATIO - DAP_ABONO_MIN_PREMIUM_RATIO);
}

export function dapAbonoAmountMatchesCargo(cargoAmount: number, abonoAmount: number, dayGap: number): boolean {
  const cargo = Math.round(Math.abs(cargoAmount));
  const abono = Math.round(abonoAmount);
  if (cargo <= 0 || abono <= 0) return false;
  if (abono < cargo) return false;
  const maxPremium = dapAbonoMaxPremiumRatioForDayGap(dayGap);
  return abono <= Math.round(cargo * (1 + maxPremium));
}

/** Parse withdrawal description from official cartola or partial import notes. */
export function cartolaDescriptionFromNote(note: string | null | undefined): string {
  const n = String(note ?? "").trim();
  const partial = parsePartialMovementNote(n);
  if (partial) return partial.description;
  if (!n.startsWith("import:cartola|")) return n;
  const rest = n.slice("import:cartola|".length);
  const firstBar = rest.indexOf("|");
  if (firstBar < 0) return rest;
  const afterPeriod = rest.slice(firstBar + 1);
  const secondBar = afterPeriod.indexOf("|");
  if (secondBar < 0) return afterPeriod.trim();
  let desc = afterPeriod.slice(secondBar + 1).trim();
  if (desc.startsWith("doc:")) desc = "";
  return stripTrailingCartolaNoteTags(desc);
}

/** Document number from `import:cartola|…|description|doc:NNNN`. */
export function cartolaDocumentFromNote(note: string | null | undefined): string | null {
  const n = String(note ?? "").trim();
  const idx = n.lastIndexOf("|doc:");
  if (idx < 0) return null;
  let doc = n.slice(idx + "|doc:".length).trim();
  const meta = doc.search(/\|(on:|amt:|idx:)/);
  if (meta >= 0) doc = doc.slice(0, meta).trim();
  return doc.length > 0 ? doc : null;
}

export function isMercadoCapitalesCargoDescription(description: string): boolean {
  const d = description.trim();
  if (!d) return false;
  if (MERCADO_CAPITALES_CARGO_RE.test(d)) return true;
  if (LONG_NUMERIC_CARGO_REF_RE.test(d.replace(/\s/g, ""))) return true;
  return false;
}

export function isDapAbonoDescription(description: string): boolean {
  return DAP_ABONADO_RE.test(description.trim());
}

export function isDapReturnCreditDescription(description: string): boolean {
  const d = description.trim();
  if (isDapAbonoDescription(d)) return true;
  return COBRO_VVISTA_DAP_RE.test(d);
}

export function isExcludedCheckingWithdrawal(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  if (!d) return true;
  if (INTERNAL_TRANSFER_RE.test(d)) return true;
  if (isCcPaymentMerchant(d)) return true;
  if (CC_PAYMENT_DESC_RE.test(d)) return true;
  if (OWN_SANTANDER_TRANSFER_RE.test(d)) return true;
  if (CUENTA_VISTA_TRANSFER_DESC_RE.test(d)) return true;
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_TRANSFER_DESC_RE.test(d)) return true;
  return false;
}

/** Incoming cartola abono excluded by description (symmetric to {@link isExcludedCheckingWithdrawal}). */
export function isExcludedCheckingInflow(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  if (!d) return true;
  if (isDapReturnCreditDescription(d)) return true;
  if (CHECKING_CORRIENTE_INTERNET_TRANSFER_RE.test(d)) return true;
  if (INTERNAL_TRANSFER_RE.test(d)) return true;
  if (OWN_SANTANDER_TRANSFER_RE.test(d)) return true;
  if (CUENTA_VISTA_TRANSFER_DESC_RE.test(d)) return true;
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_INCOMING_TRANSFER_RE.test(d)) return true;
  if (BUDA_CRYPTO_EXCHANGE_TRANSFER_RE.test(d)) return true;
  if (AFP_CHECKING_INFLOW_DESC_RE.test(d)) return true;
  return false;
}

/** Wires from checking into Fintual / reserva (capital funding, not consumption). */
export function checkingWithdrawalFundsInvestmentCapital(note: string | null): boolean {
  const d = stripCheckingBranchPrefix(cartolaDescriptionFromNote(note)).trim();
  if (FINTUAL_INVESTMENT_TRANSFER_RE.test(d)) return true;
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  return false;
}

/**
 * Only generic cartola abonos may auto-filter as net-worth capital return (checking-outflow path).
 * Named person transfers (e.g. "… Transf. Cristian Alejandro Fraser") stay in income.
 */
export function checkingCreditMayAutoMatchNetWorthCapitalReturn(description: string): boolean {
  const d = stripCheckingBranchPrefix(description).trim();
  if (!d) return false;
  if (isPayrollRemuneracionCheckingInflow(d)) return false;
  const merchantKey = normalizeCcExpenseMerchantKey(d);
  if (isExactGenericUniqueMerchantKey(merchantKey)) return true;
  if (isGenericTransferMerchantKey(merchantKey)) return true;
  if (/^(?:ABONO\s+)?TRANSFERENCIA\s+ELECTRONICA$/.test(merchantKey)) return true;
  return false;
}

/**
 * Fintual wire proceeds on cartola (ledger-return path). Truncated vista lines may be
 * "0768106274 Transf." with no FINTUAL token; named person transfers are excluded.
 */
export function checkingCreditLooksLikeFintualIncomingWire(description: string): boolean {
  const trimmed = description.trim();
  if (!trimmed) return false;
  if (isPayrollRemuneracionCheckingInflow(trimmed)) return false;
  if (FINTUAL_INCOMING_TRANSFER_RE.test(trimmed)) return true;

  const fullKey = normalizeCcExpenseMerchantKey(trimmed);
  if (/^\d{6,}\s+TRANSF\.?$/.test(fullKey)) return true;

  const strippedKey = normalizeCcExpenseMerchantKey(stripCheckingBranchPrefix(trimmed));
  if (
    /^\d{6,}\s+TRANSF/i.test(fullKey) &&
    /^TRANSF\.?$/.test(strippedKey)
  ) {
    return true;
  }
  return false;
}

export function withdrawalMayUseSplittableReservaPool(description: string): boolean {
  const d = description.trim();
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_INVESTMENT_TRANSFER_RE.test(d)) return true;
  return false;
}
