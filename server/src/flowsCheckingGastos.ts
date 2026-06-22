import { accountBucketKindSlug } from "./accountBucket.js";
import { dashboardBucketForAssetGroupSlug } from "./assetGroupTree.js";
import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { isCheckingLedgerAnchorNote } from "./checkingCartolaBalances.js";
import { checkingCartolaStablePurchaseKey, stripTrailingCartolaNoteTags } from "./checkingCartolaParse.js";
import {
  legacyCheckingGastosPurchaseKey,
  parseLegacyCheckingGastosPurchaseKey,
} from "./checkingGastosCategoryPersist.js";
import { cartolaCashAccountIdOptional, isMovementBalanceCashCategory, listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import { isExactGenericUniqueMerchantKey } from "./ccExpenseGenericUniqueMerchants.js";
import {
  getCcExpenseCategoryBySlug,
  categoryUniqueForExpenseLine,
  isCcExpenseTotalsExcludedSlug,
  isGenericTransferMerchantKey,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  merchantRuleKeysMatchingLineMerchant,
  registerGenericUniquePurchaseMode,
  registerUniquePurchaseMode,
  resolveCcExpenseCategorySlug,
  UNCLASSIFIED_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
  CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
} from "./ccExpenseCategories.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import {
  formatAutoDepositMatchNote,
  type DepositMatchAllocation,
} from "./ccExpenseDepositMatchNotes.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";

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

export type { DepositMatchAllocation };

const INVESTMENT_DEPOSIT_GROUPS = new Set(["real_estate", "brokerage", "retirement"]);

export function isInvestmentDepositTarget(groupSlug: string): boolean {
  return INVESTMENT_DEPOSIT_GROUPS.has(groupSlug);
}

export function checkingGastosMovementPurchaseKey(
  movementId: number,
  portion: "gastos" | "deposit" = "gastos"
): string {
  const row = db
    .prepare(`SELECT account_id, note FROM movements WHERE id = ?`)
    .get(movementId) as { account_id: number; note: string | null } | undefined;
  if (row?.note) {
    const stable = checkingCartolaStablePurchaseKey(row.account_id, row.note, portion);
    if (stable) return stable;
  }
  return legacyCheckingGastosPurchaseKey(movementId, portion);
}

export { legacyCheckingGastosPurchaseKey, parseLegacyCheckingGastosPurchaseKey };

export function checkingGastosMovementBelongs(movementId: number): {
  ok: boolean;
  account_id?: number;
  merchant_key?: string;
} {
  const checkingIds = new Set(listMovementBalanceCashAccountIds());
  if (checkingIds.size === 0) return { ok: false };

  const row = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, note
       FROM movements
       WHERE id = ?`
    )
    .get(movementId) as
    | { account_id: number; occurred_on: string; amount_clp: number; note: string | null }
    | undefined;

  if (!row || !checkingIds.has(row.account_id) || row.amount_clp >= 0) {
    return { ok: false };
  }

  const note = String(row.note ?? "").trim();
  if (!note.startsWith("import:cartola|") || isCheckingLedgerAnchorNote(note)) {
    return { ok: false };
  }

  const description = cartolaDescriptionFromNote(row.note);
  if (isExcludedCheckingWithdrawal(description)) {
    return { ok: false };
  }
  const depositCandidates = loadDepositMatchCandidates();
  const split = splitCheckingWithdrawalAgainstDeposits(
    { occurred_on: row.occurred_on, amount_clp: row.amount_clp, description },
    depositCandidates,
    {
      splittablePool: createSplittableInternalTransferPool(depositCandidates),
      usedDepositKeys: new Set<string>(),
      withdrawalAccountId: row.account_id,
      withdrawalCategorySlug: checkingGastosAccountCategorySlug(row.account_id),
    }
  );
  if (split.gastosClp <= 0 && split.internalClp <= 0) {
    return { ok: false };
  }
  if (
    withdrawalIsReversedByDapAbono(
      { occurred_on: row.occurred_on, amount_clp: row.amount_clp, note: row.note },
      loadMovementBalanceCashCartolaCredits()
    )
  ) {
    return { ok: false };
  }
  const deposits = loadDepositMatchCandidates();
  const internalMcMonths = computeMercadoCapitalesInternalTransferMonths(row.account_id, deposits);
  const expenseMonth = monthKeyFromYmd(row.occurred_on);
  if (
    expenseMonth &&
    internalMcMonths.has(expenseMonth) &&
    isMercadoCapitalesCargoDescription(cartolaDescriptionFromNote(row.note))
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    account_id: row.account_id,
    merchant_key: normalizeCcExpenseMerchantKey(description),
  };
}

export function assignCheckingGastosMovementCategory(opts: {
  movementId: number;
  unique: boolean;
  categorySlug?: string | null;
  clearCategory?: boolean;
}): {
  category_slug: string;
  unique: boolean;
  merchant_key: string;
  purchase_key: string;
} {
  const belong = checkingGastosMovementBelongs(opts.movementId);
  if (!belong.ok || belong.account_id == null) {
    throw new Error("checking gastos movement not found");
  }

  const categorySlug = opts.categorySlug != null ? String(opts.categorySlug).trim() : "";
  const hasCategory = categorySlug.length > 0;

  if (hasCategory && categorySlug === UNCLASSIFIED_CC_EXPENSE_SLUG) {
    throw new Error("cannot assign unclassified category");
  }

  const merchantKey = belong.merchant_key ?? "";
  if (!opts.unique && hasCategory && !merchantKey) {
    throw new Error("merchant required for comercio-wide category");
  }

  let catId: number | null = null;
  let resolvedSlug = UNCLASSIFIED_CC_EXPENSE_SLUG;
  if (hasCategory) {
    const cat = getCcExpenseCategoryBySlug(categorySlug);
    if (!cat) throw new Error("unknown category");
    catId = cat.id;
    resolvedSlug = cat.slug;
  }

  const purchaseKey = checkingGastosMovementPurchaseKey(opts.movementId);
  const purchaseKeys = [
    purchaseKey,
    ...(purchaseKey !== checkingGastosMovementPurchaseKey(opts.movementId, "deposit")
      ? [checkingGastosMovementPurchaseKey(opts.movementId, "deposit")]
      : []),
  ];
  const delUniquePurchase = db.prepare(
    `DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`
  );
  const upsertUniquePurchase = db.prepare(
    `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
  );
  const upsertMerchant = db.prepare(
    `INSERT INTO cc_expense_merchant_categories (account_id, merchant_key, category_id)
     VALUES (?, ?, ?)
     ON CONFLICT(account_id, merchant_key) DO UPDATE SET category_id = excluded.category_id`
  );
  const delMerchant = db.prepare(
    `DELETE FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`
  );

  const tx = db.transaction(() => {
    if (opts.clearCategory) {
      if (opts.unique) {
        for (const key of purchaseKeys) {
          upsertUniquePurchase.run(belong.account_id, key, null);
        }
      } else {
        for (const key of purchaseKeys) {
          delUniquePurchase.run(belong.account_id, key);
        }
        for (const ruleKey of merchantRuleKeysMatchingLineMerchant(belong.account_id, merchantKey)) {
          delMerchant.run(belong.account_id, ruleKey);
        }
      }
      return;
    }

    if (opts.unique) {
      for (const key of purchaseKeys) {
        delUniquePurchase.run(belong.account_id, key);
      }
      upsertUniquePurchase.run(belong.account_id, purchaseKey, catId);
    } else {
      for (const key of purchaseKeys) {
        delUniquePurchase.run(belong.account_id, key);
      }
      if (catId != null && merchantKey) {
        upsertMerchant.run(belong.account_id, merchantKey, catId);
      }
    }
  });
  tx();

  if (opts.clearCategory) {
    return {
      category_slug: UNCLASSIFIED_CC_EXPENSE_SLUG,
      unique: opts.unique,
      merchant_key: merchantKey,
      purchase_key: purchaseKey,
    };
  }

  return {
    category_slug: resolvedSlug,
    unique: opts.unique,
    merchant_key: merchantKey,
    purchase_key: purchaseKey,
  };
}

const INTERNAL_TRANSFER_RE = /CRISTIAN\s+FRASER\s*-\s*SANTANDER/i;
const CC_PAYMENT_DESC_RE =
  /MONTO\s+CANCELADO|PAGO\s+.*TARJETA|TARJETA\s+DE\s+CR[EÉ]DITO|PAGO\s+TARJETA|TRASPASO(?:\s+\w+)*\s+A\s+T\.?\s*CR[EÉ]DITO|TRASPASO(?:\s+\w+)*\s+A\s+L[IÍ]NEA\s+CR[EÉ]DITO|(?:EGRESO\s+POR\s+)?COMPRA\s+DE\s+DIVISAS/i;
/** Own Santander account transfers (not spending). */
const OWN_SANTANDER_TRANSFER_RE = /TRASPASO(?:\s+\w+)*\s+A\s+CUENTAM[AÁ]TICA/i;
/** Transfers to cuenta vista (CUENTAMATICA / vale vista), e.g. AFP 10% retiros. */
export const CUENTA_VISTA_TRANSFER_DESC_RE =
  /TRASPASO(?:\s+\w+)*\s+A\s+CUENTA\s+VISTA/i;
/** Transfers to Fondo reserva (internal, not consumption). */
const RESERVA_TRANSFER_DESC_RE =
  /\bRESERVA\b|FONDO\s+RESERVA|TRASPASO(?:\s+\w+)*\s+A\s+.*\bRESERVA\b|DEP[OÓ]SITO(?:\s+\w+)*\s+A\s+.*\bRESERVA\b/i;

/** Wires to Fintual (investment funding — excluded from gastos list). */
const FINTUAL_TRANSFER_DESC_RE = /FINTUAL\s+ADMINISTRADORA/i;

/** Incoming checking abono from Fintual (capital return from net-worth accounts). */
const FINTUAL_INCOMING_TRANSFER_RE = /\bFINTUAL\b/i;

/** Buda.com crypto exchange wires into checking (sale proceeds, not salary / external income). */
const BUDA_CRYPTO_EXCHANGE_TRANSFER_RE = /\bTRANSF\.?\s+.*\bBUDA\b/i;

/** AFP 10% retiro proceeds wired into checking (not external income). */
const AFP_CHECKING_INFLOW_DESC_RE = /\bABONO\s+10\s*%\s*AFP\b|\bANTI\s+PREV\s+AFP\b/i;

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
  if (FINTUAL_TRANSFER_DESC_RE.test(d)) return true;
  const merchantKey = normalizeCcExpenseMerchantKey(d);
  if (isExactGenericUniqueMerchantKey(merchantKey)) return true;
  if (isGenericTransferMerchantKey(merchantKey)) return true;
  return false;
}

export function autoMatchCategorySlugForDeposit(
  deposit: Pick<DepositMatchCandidate, "category_slug" | "group_slug">
): string {
  if (isInvestmentDepositTarget(deposit.group_slug)) return DEPOSITS_CC_EXPENSE_SLUG;
  if (SPLITTABLE_INTERNAL_TRANSFER_CATEGORIES.has(deposit.category_slug)) {
    return DEPOSITS_CC_EXPENSE_SLUG;
  }
  if (MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(deposit.category_slug)) {
    return DEPOSITS_CC_EXPENSE_SLUG;
  }
  if (
    deposit.group_slug === CHECKING_GASTOS_CASH_GROUP &&
    isMovementBalanceCashCategory(deposit.category_slug)
  ) {
    return CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG;
  }
  return DEPOSITS_CC_EXPENSE_SLUG;
}

export function autoMatchCategorySlugForAllocations(
  allocations: readonly DepositMatchAllocation[]
): string {
  if (allocations.length === 0) return DEPOSITS_CC_EXPENSE_SLUG;
  return autoMatchCategorySlugForDeposit(allocations[0]!.deposit);
}

export function resolveAutoMatchCategorySlugForCheckingWithdrawal(
  withdrawal: { occurred_on: string; amount_clp: number; description?: string },
  deposits: readonly DepositMatchCandidate[],
  withdrawalAccountId: number
): string | null {
  const description = withdrawal.description ?? "";
  if (isCheckingCorrienteVistaTraspasoOutflow(description)) {
    return CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG;
  }
  if (!checkingWithdrawalMayAutoMatchDeposit(description)) return null;
  const split = splitCheckingWithdrawalAgainstDeposits(withdrawal, deposits, {
    splittablePool: createSplittableInternalTransferPool(deposits),
    usedDepositKeys: new Set<string>(),
    withdrawalAccountId,
    withdrawalCategorySlug: checkingGastosAccountCategorySlug(withdrawalAccountId),
  });
  if (split.internalClp > 0) {
    return autoMatchCategorySlugForAllocations(split.internalMatchedDeposits);
  }
  if (split.investmentDeposit != null) return DEPOSITS_CC_EXPENSE_SLUG;
  return null;
}

/** Santander capital-markets money order charge (downpayment rail). */
const MERCADO_CAPITALES_CARGO_RE = /Cargo\s+Mercado\s+Capitales/i;
/** Long numeric cartola reference used for the same money-order rail. */
const LONG_NUMERIC_CARGO_REF_RE = /^\d{10,}$/;

/** DAP refund when a money order was annulled or a DAP matured (paired with cargo by `doc:`). */
const DAP_ABONADO_RE = /\bDAP\s+(\d+)\s+ABONADO\b/i;
/** Cuenta vista return of a DAP placed via Mercado Capitales (vale vista collection). */
const COBRO_VVISTA_DAP_RE = /\bCOBRO\s+VVISTA\s+(\d+)/i;

/** @deprecated Use {@link DAP_ABONO_MAX_DAY_GAP} */
export const ANNULLED_MONEY_ORDER_MAX_DAY_GAP = 14;

/** Max days between MC cargo and matching DAP ABONADO credit (12 months). */
export const DAP_ABONO_MAX_DAY_GAP = 365;

/** Min premium on short DAP maturities (e.g. 42-day ~0.49% on Aug 2024 doc 9204418). */
export const DAP_ABONO_MIN_PREMIUM_RATIO = 0.01;

/** Max premium at {@link DAP_ABONO_MAX_DAY_GAP} (longer DAP terms). */
export const DAP_ABONO_MAX_PREMIUM_RATIO = 0.1;

/** Abono `doc:` may be cargo doc + N (Santander cartola numbering). */
export const DAP_ABONO_DOC_SPREAD = 2;

export type CheckingCartolaCredit = {
  occurred_on: string;
  amount_clp: number;
  note: string | null;
};

export type CheckingCartolaWithdrawal = CheckingCartolaCredit;

export type DepositMatchCandidate = {
  occurred_on: string;
  amount_clp: number;
  account_id: number;
  category_slug: string;
  group_slug: string;
};

/** Cash accounts whose inflows are month-end aggregates (no exact transfer dates). */
export const MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES = new Set(["cuenta_ahorro_vivienda"]);

/** Fintual reserva deposits may be merged on one day; checking wires can split against one lump sum. */
export const SPLITTABLE_INTERNAL_TRANSFER_CATEGORIES = new Set(["fondo_reserva"]);

function splittableDepositPoolKey(d: Pick<DepositMatchCandidate, "account_id" | "occurred_on" | "amount_clp">): string {
  return `${d.account_id}|${d.occurred_on}|${d.amount_clp}`;
}

export function createSplittableInternalTransferPool(
  deposits: readonly DepositMatchCandidate[]
): Map<string, number> {
  const pool = new Map<string, number>();
  for (const d of deposits) {
    if (!SPLITTABLE_INTERNAL_TRANSFER_CATEGORIES.has(d.category_slug)) continue;
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    pool.set(splittableDepositPoolKey(d), Math.round(d.amount_clp));
  }
  return pool;
}

export function depositMatchesInternalTransferTiming(
  withdrawal: { occurred_on: string },
  deposit: Pick<DepositMatchCandidate, "occurred_on" | "category_slug">,
  maxDayGap = 3
): boolean {
  if (MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(deposit.category_slug)) {
    const withdrawalMonth = monthKeyFromYmd(withdrawal.occurred_on);
    const depositMonth = monthKeyFromYmd(deposit.occurred_on);
    return withdrawalMonth != null && withdrawalMonth === depositMonth;
  }
  return daysBetweenYmd(deposit.occurred_on, withdrawal.occurred_on) <= maxDayGap;
}

function daysBetweenYmd(a: string, b: string): number {
  const ta = Date.parse(`${a}T12:00:00Z`);
  const tb = Date.parse(`${b}T12:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return 999;
  return Math.round(Math.abs(ta - tb) / 86_400_000);
}

function signedDaysFromTo(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 999;
  return Math.round((to - from) / 86_400_000);
}

function dapReferenceFromDescription(description: string): string | null {
  const d = description.trim();
  const abono = DAP_ABONADO_RE.exec(d);
  if (abono?.[1]) return abono[1];
  const vv = COBRO_VVISTA_DAP_RE.exec(d);
  return vv?.[1] ?? null;
}

function cartolaDocsMatchForDapAbono(cargoDoc: string, creditDoc: string | null, dapRef: string | null): boolean {
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

function dapAbonoAmountMatchesCargo(cargoAmount: number, abonoAmount: number, dayGap: number): boolean {
  const cargo = Math.round(Math.abs(cargoAmount));
  const abono = Math.round(abonoAmount);
  if (cargo <= 0 || abono <= 0) return false;
  if (abono < cargo) return false;
  const maxPremium = dapAbonoMaxPremiumRatioForDayGap(dayGap);
  return abono <= Math.round(cargo * (1 + maxPremium));
}

/** Parse cartola `description` from `import:cartola|period|branch|description…`. */
export function cartolaDescriptionFromNote(note: string | null | undefined): string {
  const n = String(note ?? "").trim();
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

export function loadCheckingCartolaCredits(accountId: number): CheckingCartolaCredit[] {
  return db
    .prepare(
      `SELECT occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp > 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingCartolaCredit[];
}

export function loadMovementBalanceCashCartolaCredits(
  accountIds = listMovementBalanceCashAccountIds()
): CheckingCartolaCredit[] {
  const out: CheckingCartolaCredit[] = [];
  for (const accountId of accountIds) {
    out.push(...loadCheckingCartolaCredits(accountId));
  }
  out.sort((a, b) => {
    const d = a.occurred_on.localeCompare(b.occurred_on);
    if (d !== 0) return d;
    return a.amount_clp - b.amount_clp;
  });
  return out;
}

export function loadCheckingCartolaWithdrawals(accountId: number): CheckingCartolaWithdrawal[] {
  return db
    .prepare(
      `SELECT occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp < 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:cartola|anchor|%'
       ORDER BY occurred_on, id`
    )
    .all(accountId) as CheckingCartolaWithdrawal[];
}

/**
 * Calendar months where non-annulled Mercado Capitales cargos from checking sum to
 * cash/efectivo inflows (e.g. lump deposit into cuenta de ahorro para la vivienda).
 */
export function computeMercadoCapitalesInternalTransferMonths(
  accountId: number,
  depositCandidates: readonly DepositMatchCandidate[],
  opts?: {
    checkingWithdrawals?: readonly CheckingCartolaWithdrawal[];
    checkingCredits?: readonly CheckingCartolaCredit[];
  }
): Set<string> {
  const withdrawals = opts?.checkingWithdrawals ?? loadCheckingCartolaWithdrawals(accountId);
  const credits = opts?.checkingCredits ?? loadCheckingCartolaCredits(accountId);

  const mcByMonth = new Map<string, number>();
  for (const row of withdrawals) {
    const desc = cartolaDescriptionFromNote(row.note);
    if (!isMercadoCapitalesCargoDescription(desc)) continue;
    if (withdrawalIsReversedByDapAbono({ occurred_on: row.occurred_on, amount_clp: row.amount_clp, note: row.note }, credits)) {
      continue;
    }
    const month = monthKeyFromYmd(row.occurred_on);
    if (!month) continue;
    mcByMonth.set(month, (mcByMonth.get(month) ?? 0) + Math.round(Math.abs(row.amount_clp)));
  }

  const cashInByMonth = new Map<string, number>();
  for (const d of depositCandidates) {
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (d.category_slug === "cuenta_corriente") continue;
    const month = monthKeyFromYmd(d.occurred_on);
    if (!month) continue;
    cashInByMonth.set(month, (cashInByMonth.get(month) ?? 0) + Math.round(d.amount_clp));
  }

  const out = new Set<string>();
  for (const [month, mcSum] of mcByMonth) {
    if (mcSum > 0 && cashInByMonth.get(month) === mcSum) out.add(month);
  }
  return out;
}

/**
 * True when a later DAP ABONADO credit reverses this Mercado Capitales cargo
 * (annulled money order or DAP maturity with principal + small interest).
 */
export function withdrawalIsReversedByDapAbono(
  withdrawal: { occurred_on: string; amount_clp: number; note: string | null },
  checkingCredits: readonly CheckingCartolaCredit[],
  maxDayGap = DAP_ABONO_MAX_DAY_GAP
): boolean {
  const desc = cartolaDescriptionFromNote(withdrawal.note);
  if (!isMercadoCapitalesCargoDescription(desc)) return false;
  const doc = cartolaDocumentFromNote(withdrawal.note);
  if (!doc) return false;
  for (const credit of checkingCredits) {
    const creditDesc = cartolaDescriptionFromNote(credit.note);
    if (!isDapReturnCreditDescription(creditDesc)) continue;
    const creditDoc = cartolaDocumentFromNote(credit.note);
    const dapRef = dapReferenceFromDescription(creditDesc);
    if (!cartolaDocsMatchForDapAbono(doc, creditDoc, dapRef)) continue;
    const dayGap = signedDaysFromTo(withdrawal.occurred_on, credit.occurred_on);
    if (dayGap < 0 || dayGap > maxDayGap) continue;
    if (!dapAbonoAmountMatchesCargo(withdrawal.amount_clp, credit.amount_clp, dayGap)) continue;
    return true;
  }
  return false;
}

/** @deprecated Use {@link withdrawalIsReversedByDapAbono} */
export function withdrawalIsAnnulledMoneyOrder(
  withdrawal: { occurred_on: string; amount_clp?: number; note: string | null },
  checkingCredits: readonly CheckingCartolaCredit[],
  maxDayGap = ANNULLED_MONEY_ORDER_MAX_DAY_GAP
): boolean {
  const desc = cartolaDescriptionFromNote(withdrawal.note);
  if (!isMercadoCapitalesCargoDescription(desc)) return false;
  const doc = cartolaDocumentFromNote(withdrawal.note);
  if (!doc) return false;
  for (const credit of checkingCredits) {
    const creditDesc = cartolaDescriptionFromNote(credit.note);
    if (!isDapReturnCreditDescription(creditDesc)) continue;
    const creditDoc = cartolaDocumentFromNote(credit.note);
    const dapRef = dapReferenceFromDescription(creditDesc);
    if (!cartolaDocsMatchForDapAbono(doc, creditDoc, dapRef)) continue;
    if (daysBetweenYmd(credit.occurred_on, withdrawal.occurred_on) > maxDayGap) continue;
    if (signedDaysFromTo(withdrawal.occurred_on, credit.occurred_on) < 0) continue;
    if (
      withdrawal.amount_clp != null &&
      !dapAbonoAmountMatchesCargo(
        withdrawal.amount_clp,
        credit.amount_clp,
        signedDaysFromTo(withdrawal.occurred_on, credit.occurred_on)
      )
    ) {
      continue;
    }
    return true;
  }
  return false;
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

/**
 * DAP ABONADO / COBRO VVISTA credit that pairs with a Mercado Capitales cargo (product return, not income).
 */
export function creditIsReversingMercadoCapitalesCargo(
  credit: CheckingCartolaCredit,
  checkingWithdrawals: readonly CheckingCartolaWithdrawal[],
  maxDayGap = DAP_ABONO_MAX_DAY_GAP
): boolean {
  const creditDesc = cartolaDescriptionFromNote(credit.note);
  if (!isDapReturnCreditDescription(creditDesc)) return false;
  const creditDoc = cartolaDocumentFromNote(credit.note);
  const dapRef = dapReferenceFromDescription(creditDesc);
  for (const withdrawal of checkingWithdrawals) {
    const desc = cartolaDescriptionFromNote(withdrawal.note);
    if (!isMercadoCapitalesCargoDescription(desc)) continue;
    const doc = cartolaDocumentFromNote(withdrawal.note);
    if (!doc) continue;
    if (!cartolaDocsMatchForDapAbono(doc, creditDoc, dapRef)) continue;
    const dayGap = signedDaysFromTo(withdrawal.occurred_on, credit.occurred_on);
    if (dayGap < 0 || dayGap > maxDayGap) continue;
    if (!dapAbonoAmountMatchesCargo(withdrawal.amount_clp, credit.amount_clp, dayGap)) continue;
    return true;
  }
  return false;
}

export type CheckingCartolaWithdrawalWithAccount = CheckingCartolaWithdrawal & { account_id: number };

export function loadAllCheckingCartolaWithdrawals(): CheckingCartolaWithdrawalWithAccount[] {
  const out: CheckingCartolaWithdrawalWithAccount[] = [];
  for (const accountId of listMovementBalanceCashAccountIds()) {
    for (const row of loadCheckingCartolaWithdrawals(accountId)) {
      out.push({ ...row, account_id: accountId });
    }
  }
  return out;
}

/** Abono that pairs with a sibling checking withdrawal classified as internal transfer. */
export function checkingCreditMatchesInternalWithdrawal(
  credit: { occurred_on: string; amount_clp: number; note: string | null },
  creditAccountId: number,
  checkingWithdrawals: readonly CheckingCartolaWithdrawalWithAccount[],
  deposits: readonly DepositMatchCandidate[],
  splittablePool: Map<string, number>,
  maxDayGap = 3
): boolean {
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  for (const row of checkingWithdrawals) {
    if (Math.round(Math.abs(row.amount_clp)) !== want) continue;
    if (daysBetweenYmd(credit.occurred_on, row.occurred_on) > maxDayGap) continue;
    const wDesc = cartolaDescriptionFromNote(row.note);
    const withdrawal = {
      occurred_on: row.occurred_on,
      amount_clp: row.amount_clp,
      description: wDesc,
    };
    if (
      withdrawalMatchesInternalCashTransfer(
        withdrawal,
        deposits,
        maxDayGap,
        splittablePool,
        row.account_id
      )
    ) {
      return true;
    }
    if (
      row.account_id !== creditAccountId &&
      isCheckingCorrienteVistaTraspasoOutflow(wDesc) &&
      CHECKING_CORRIENTE_INTERNET_TRANSFER_RE.test(
        stripCheckingBranchPrefix(cartolaDescriptionFromNote(credit.note)).trim()
      )
    ) {
      return true;
    }
  }
  return false;
}

/** Negative capital events on net-worth accounts (withdrawals / returns toward checking). */
export const NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP = 14;

/** AFP retiro ledger rows often post days after the checking abono (bidirectional match window). */
export const AFP_RETIRO_RETURN_MAX_DAY_GAP = 31;

export function loadNetWorthCapitalOutflowCandidates(): DepositMatchCandidate[] {
  const accounts = listDepositFlowAccounts().filter(
    (a) => !isMovementBalanceCashCategory(a.category_slug)
  );
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const byAccount = loadMergedDepositInflowEvents(ids);
  const out: DepositMatchCandidate[] = [];
  for (const [accountId, events] of byAccount) {
    const meta = metaById.get(accountId);
    if (!meta) continue;
    for (const e of events) {
      if (e.amt >= 0 || !Number.isFinite(e.amt)) continue;
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(Math.abs(e.amt)),
        account_id: accountId,
        category_slug: meta.category_slug,
        group_slug: meta.group_slug,
      });
    }
  }
  return out;
}

export function loadAfpRetiroOutflowCandidates(): DepositMatchCandidate[] {
  return loadNetWorthCapitalOutflowCandidates().filter((c) => c.category_slug === "afp");
}

export function checkingCreditMatchesAfpRetiroReturn(
  credit: { occurred_on: string; amount_clp: number },
  afpOutflows: readonly DepositMatchCandidate[],
  maxDayGap = AFP_RETIRO_RETURN_MAX_DAY_GAP
): boolean {
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  for (const o of afpOutflows) {
    if (Math.round(o.amount_clp) !== want) continue;
    if (daysBetweenYmd(o.occurred_on, credit.occurred_on) > maxDayGap) continue;
    return true;
  }
  return false;
}

/** @deprecated Use {@link loadNetWorthCapitalOutflowCandidates}. */
export function loadInvestmentCapitalOutflowCandidates(): DepositMatchCandidate[] {
  return loadNetWorthCapitalOutflowCandidates();
}

export function checkingCreditMatchesNetWorthCapitalReturn(
  credit: { occurred_on: string; amount_clp: number },
  outflows: readonly DepositMatchCandidate[],
  maxDayGap = NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP
): boolean {
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  for (const o of outflows) {
    if (Math.round(o.amount_clp) !== want) continue;
    const dayGap = signedDaysFromTo(o.occurred_on, credit.occurred_on);
    if (dayGap < 0 || dayGap > maxDayGap) continue;
    return true;
  }
  return false;
}

/** @deprecated Use {@link checkingCreditMatchesNetWorthCapitalReturn}. */
export function checkingCreditMatchesInvestmentCapitalReturn(
  credit: { occurred_on: string; amount_clp: number },
  outflows: readonly DepositMatchCandidate[],
  maxDayGap = NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP
): boolean {
  return checkingCreditMatchesNetWorthCapitalReturn(credit, outflows, maxDayGap);
}

export function withdrawalMayUseSplittableReservaPool(description: string): boolean {
  const d = description.trim();
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  if (FINTUAL_TRANSFER_DESC_RE.test(d)) return true;
  return false;
}

export function fondoReservaAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug = 'fondo_reserva' OR g.slug LIKE '%__fondo_reserva'
       LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

function listDepositFlowAccounts(): { account_id: number; category_slug: string; group_slug: string }[] {
  const rows = db
    .prepare(
      `SELECT a.id AS account_id, g.slug AS bucket_slug
       FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE (a.notes IS NULL OR a.notes != ?)
         AND COALESCE(a.exclude_from_group_totals, 0) = 0
         AND g.slug != 'individual_stocks'`
    )
    .all(NOTE_STOCKS_LEGACY) as { account_id: number; bucket_slug: string }[];
  return rows
    .map((r) => {
      const dash = dashboardBucketForAssetGroupSlug(r.bucket_slug);
      if (!dash || !["real_estate", "cash_eqs", "brokerage", "retirement"].includes(dash)) {
        return null;
      }
      return {
        account_id: r.account_id,
        category_slug: accountBucketKindSlug(r.bucket_slug),
        group_slug: dash,
      };
    })
    .filter((r): r is { account_id: number; category_slug: string; group_slug: string } => r != null);
}

function depositIsCrossAccountInternalTransfer(
  deposit: Pick<DepositMatchCandidate, "account_id">,
  withdrawalAccountId: number
): boolean {
  return deposit.account_id !== withdrawalAccountId;
}

function withdrawalMatchesInternalCashTransferExact(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap: number,
  withdrawalAccountId: number
): boolean {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) return false;
  for (const d of deposits) {
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (!depositIsCrossAccountInternalTransfer(d, withdrawalAccountId)) continue;
    if (Math.round(d.amount_clp) !== want) continue;
    if (depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)) return true;
  }
  return false;
}

/** Lump-sum reserva imports share one cartola day; only same-day checking wires may split against them. */
function depositMatchesSplittableInternalTransferTiming(
  withdrawal: { occurred_on: string },
  deposit: Pick<DepositMatchCandidate, "occurred_on">
): boolean {
  return withdrawal.occurred_on === deposit.occurred_on;
}

function tryAllocateSplittableInternalTransferAmount(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  pool: Map<string, number>,
  maxTake: number
): { take: number; deposit: DepositMatchCandidate | null } {
  const cap = Math.round(maxTake);
  if (cap <= 0) return { take: 0, deposit: null };
  for (const d of deposits) {
    if (!SPLITTABLE_INTERNAL_TRANSFER_CATEGORIES.has(d.category_slug)) continue;
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (!depositMatchesSplittableInternalTransferTiming(withdrawal, d)) continue;
    const key = splittableDepositPoolKey(d);
    const poolRemaining = pool.get(key);
    if (poolRemaining == null || poolRemaining <= 0) continue;
    const take = Math.min(cap, poolRemaining);
    pool.set(key, poolRemaining - take);
    return { take, deposit: d };
  }
  return { take: 0, deposit: null };
}

function tryAllocateSplittableInternalTransfer(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  pool: Map<string, number>
): boolean {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  return tryAllocateSplittableInternalTransferAmount(withdrawal, deposits, pool, want).take === want;
}

function findExactInternalCashTransferDeposit(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap: number,
  withdrawalAccountId: number
): DepositMatchCandidate | null {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) return null;
  for (const d of deposits) {
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (!depositIsCrossAccountInternalTransfer(d, withdrawalAccountId)) continue;
    if (Math.round(d.amount_clp) !== want) continue;
    if (depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)) return d;
  }
  return null;
}

function resolveInternalCashTransferMatch(
  withdrawal: { occurred_on: string; amount_clp: number; description?: string },
  deposits: readonly DepositMatchCandidate[],
  splittablePool: Map<string, number>,
  maxDayGap: number,
  withdrawalAccountId: number
): { matched: boolean; allocations: DepositMatchAllocation[] } {
  if (checkingOutflowIsAtmWithdrawal(withdrawal.description ?? "")) {
    return { matched: false, allocations: [] };
  }
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (checkingWithdrawalMayAutoMatchDeposit(withdrawal.description ?? "")) {
    const exact = findExactInternalCashTransferDeposit(
      withdrawal,
      deposits,
      maxDayGap,
      withdrawalAccountId
    );
    if (exact != null) {
      return { matched: true, allocations: [{ deposit: exact, amount_clp: want }] };
    }
  }
  if (!withdrawalMayUseSplittableReservaPool(withdrawal.description ?? "")) {
    return { matched: false, allocations: [] };
  }
  const { take, deposit } = tryAllocateSplittableInternalTransferAmount(
    withdrawal,
    deposits,
    splittablePool,
    want
  );
  if (take === want && deposit != null) {
    return { matched: true, allocations: [{ deposit, amount_clp: take }] };
  }
  return { matched: false, allocations: [] };
}

export type CheckingWithdrawalDepositSplit = {
  internalClp: number;
  internalMatchedDeposits: DepositMatchAllocation[];
  investmentDeposit: DepositMatchCandidate | null;
  investmentMatchClp: number;
  gastosClp: number;
};

/**
 * Partial internal + gastos on a generic wire (no investment/reserva backing) leaves a
 * computed gastos amount that is not a cartola outflow — reject and use full withdrawal.
 */
export function isOrphanCheckingWithdrawalSplit(
  withdrawal: { description?: string },
  split: Pick<
    CheckingWithdrawalDepositSplit,
    "internalClp" | "gastosClp" | "investmentDeposit" | "investmentMatchClp"
  >
): boolean {
  if (split.internalClp <= 0 || split.gastosClp <= 0) return false;
  if (
    split.investmentDeposit != null &&
    split.investmentMatchClp === split.gastosClp
  ) {
    return false;
  }
  if (withdrawalMayUseSplittableReservaPool(withdrawal.description ?? "")) {
    return false;
  }
  return true;
}

function rollbackCheckingWithdrawalSplitSideEffects(
  opts: {
    splittablePool: Map<string, number>;
    usedDepositKeys: Set<string>;
  },
  before: {
    depositKeys: Set<string>;
    pool: Map<string, number>;
  }
): void {
  for (const key of opts.usedDepositKeys) {
    if (!before.depositKeys.has(key)) opts.usedDepositKeys.delete(key);
  }
  opts.splittablePool.clear();
  for (const [k, v] of before.pool) {
    opts.splittablePool.set(k, v);
  }
}

/** Splits a checking outflow across internal cash and investment deposits; remainder is gastos. */
export function splitCheckingWithdrawalAgainstDeposits(
  withdrawal: { occurred_on: string; amount_clp: number; description?: string },
  deposits: readonly DepositMatchCandidate[],
  opts: {
    splittablePool: Map<string, number>;
    usedDepositKeys: Set<string>;
    withdrawalAccountId: number;
    withdrawalCategorySlug: string;
    maxDayGap?: number;
  }
): CheckingWithdrawalDepositSplit {
  const description = withdrawal.description ?? "";
  const maxDayGap = opts.maxDayGap ?? 3;
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) {
    return {
      internalClp: 0,
      internalMatchedDeposits: [],
      investmentDeposit: null,
      investmentMatchClp: 0,
      gastosClp: 0,
    };
  }

  if (checkingOutflowIsAtmWithdrawal(description)) {
    return {
      internalClp: 0,
      internalMatchedDeposits: [],
      investmentDeposit: null,
      investmentMatchClp: 0,
      gastosClp: want,
    };
  }

  let internalClp = 0;
  let remaining = want;
  const internalMatchedDeposits: DepositMatchAllocation[] = [];

  const mayAutoMatchDeposit = checkingWithdrawalMayAutoMatchDeposit(description);
  const exactDeposit = mayAutoMatchDeposit
    ? findExactInternalCashTransferDeposit(
        withdrawal,
        deposits,
        maxDayGap,
        opts.withdrawalAccountId
      )
    : null;
  if (exactDeposit != null) {
    opts.usedDepositKeys.add(splittableDepositPoolKey(exactDeposit));
    return {
      internalClp: want,
      internalMatchedDeposits: [{ deposit: exactDeposit, amount_clp: want }],
      investmentDeposit: null,
      investmentMatchClp: 0,
      gastosClp: 0,
    };
  }

  const sideEffectsBefore = {
    depositKeys: new Set(opts.usedDepositKeys),
    pool: new Map(opts.splittablePool),
  };

  if (remaining > 0 && withdrawalMayUseSplittableReservaPool(description)) {
    const { take, deposit } = tryAllocateSplittableInternalTransferAmount(
      withdrawal,
      deposits,
      opts.splittablePool,
      remaining
    );
    if (take > 0 && deposit != null) {
      internalClp += take;
      internalMatchedDeposits.push({ deposit, amount_clp: take });
      remaining = want - internalClp;
    }
  }

  const investmentDeposit =
    remaining > 0 && mayAutoMatchDeposit
      ? matchWithdrawalToInvestmentDeposit(
          { occurred_on: withdrawal.occurred_on, amount_clp: -remaining },
          deposits,
          maxDayGap,
          opts.usedDepositKeys
        )
      : null;

  let investmentMatchClp = 0;
  if (investmentDeposit != null) {
    opts.usedDepositKeys.add(splittableDepositPoolKey(investmentDeposit));
    investmentMatchClp = remaining;
  }

  const split: CheckingWithdrawalDepositSplit = {
    internalClp,
    internalMatchedDeposits,
    investmentDeposit,
    investmentMatchClp,
    gastosClp: remaining,
  };

  if (isOrphanCheckingWithdrawalSplit(withdrawal, split)) {
    rollbackCheckingWithdrawalSplitSideEffects(
      {
        splittablePool: opts.splittablePool,
        usedDepositKeys: opts.usedDepositKeys,
      },
      sideEffectsBefore
    );
    return {
      internalClp: 0,
      internalMatchedDeposits: [],
      investmentDeposit: null,
      investmentMatchClp: 0,
      gastosClp: want,
    };
  }

  return split;
}

/** Checking outflow that pairs with an inflow on another cash/efectivo account (internal transfer). */
export function withdrawalMatchesInternalCashTransfer(
  withdrawal: { occurred_on: string; amount_clp: number; description?: string },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap = 3,
  splittablePool?: Map<string, number>,
  withdrawalAccountId?: number
): boolean {
  if (checkingOutflowIsAtmWithdrawal(withdrawal.description ?? "")) return false;
  const accountId = withdrawalAccountId ?? -1;
  if (withdrawalMatchesInternalCashTransferExact(withdrawal, deposits, maxDayGap, accountId)) {
    return true;
  }
  if (splittablePool == null) return false;
  if (!withdrawalMayUseSplittableReservaPool(withdrawal.description ?? "")) return false;
  return tryAllocateSplittableInternalTransfer(withdrawal, deposits, splittablePool);
}

/** @deprecated Use {@link withdrawalMatchesInternalCashTransfer}. */
export function withdrawalMatchesReservaDeposit(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap = 3
): boolean {
  return withdrawalMatchesInternalCashTransfer(withdrawal, deposits, maxDayGap);
}

function loadCuentaVistaInternalTransferCredits(): DepositMatchCandidate[] {
  const vistaId = cartolaCashAccountIdOptional("cuenta_vista");
  if (vistaId == null) return [];
  const byAccount = loadMergedDepositInflowEvents([vistaId]);
  const events = byAccount.get(vistaId) ?? [];
  return events
    .filter((e) => e.amt > 0 && Number.isFinite(e.amt))
    .map((e) => ({
      occurred_on: e.occurred_on,
      amount_clp: Math.round(e.amt),
      account_id: vistaId,
      category_slug: "cuenta_vista",
      group_slug: CHECKING_GASTOS_CASH_GROUP,
    }));
}

function checkingGastosAccountCategorySlug(accountId: number): string {
  const row = db
    .prepare(
      `SELECT g.slug AS bucket_slug FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE a.id = ?`
    )
    .get(accountId) as { bucket_slug: string } | undefined;
  return row ? accountBucketKindSlug(row.bucket_slug) : "";
}

export function loadDepositMatchCandidates(): DepositMatchCandidate[] {
  const accounts = listDepositFlowAccounts();
  const ids = accounts.map((a) => a.account_id);
  const metaById = new Map(
    accounts.map((a) => [a.account_id, { category_slug: a.category_slug, group_slug: a.group_slug }])
  );
  const byAccount = loadMergedDepositInflowEvents(ids);
  const out: DepositMatchCandidate[] = [];
  for (const [accountId, events] of byAccount) {
    const meta = metaById.get(accountId);
    const category_slug = meta?.category_slug ?? "";
    const group_slug = meta?.group_slug ?? "";
    for (const e of events) {
      if (e.amt <= 0 || !Number.isFinite(e.amt)) continue;
      out.push({
        occurred_on: e.occurred_on,
        amount_clp: Math.round(e.amt),
        account_id: accountId,
        category_slug,
        group_slug,
      });
    }
  }
  return [...out, ...loadCuentaVistaInternalTransferCredits()];
}

export function matchWithdrawalToInvestmentDeposit(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap = 3,
  usedDepositKeys?: Set<string>
): DepositMatchCandidate | null {
  const investment = deposits.filter(
    (d) => isInvestmentDepositTarget(d.group_slug) || d.category_slug === "usd"
  );
  return matchWithdrawalToDeposit(withdrawal, investment, maxDayGap, usedDepositKeys);
}

export function matchWithdrawalToDeposit(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap = 3,
  usedDepositKeys?: Set<string>
): DepositMatchCandidate | null {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) return null;
  for (const d of deposits) {
    const key = splittableDepositPoolKey(d);
    if (usedDepositKeys?.has(key)) continue;
    if (Math.round(d.amount_clp) !== want) continue;
    if (depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)) return d;
  }
  return null;
}

export function buildCheckingGastosLines(opts?: {
  accountId?: number;
  depositCandidates?: readonly DepositMatchCandidate[];
  checkingCredits?: readonly CheckingCartolaCredit[];
  merchantRules?: Map<string, string>;
  uniquePurchases?: Map<string, string>;
  uniquePurchaseModeKeys?: Set<string>;
}): FlowCcExpenseLineRowDraft[] {
  const accountId = opts?.accountId ?? checkingAccountId();
  const deposits = opts?.depositCandidates ?? loadDepositMatchCandidates();
  const splittablePool = createSplittableInternalTransferPool(deposits);
  const checkingCredits = opts?.checkingCredits ?? loadMovementBalanceCashCartolaCredits();
  const withdrawalCategorySlug = checkingGastosAccountCategorySlug(accountId);
  const categoryMaps =
    opts?.merchantRules != null
      ? {
          merchantRules: opts.merchantRules,
          uniquePurchases: opts.uniquePurchases ?? new Map<string, string>(),
          uniquePurchaseModeKeys: opts.uniquePurchaseModeKeys ?? new Set<string>(),
        }
      : loadCcExpenseCategoryMaps([accountId]);
  const { merchantRules, uniquePurchases, uniquePurchaseModeKeys } = categoryMaps;
  /** NULL-category Único rows from DB — do not treat in-request generic Único registration as cleared. */
  const userClearedUniqueAtLoad = new Set(uniquePurchaseModeKeys);

  const rows = db
    .prepare(
      `SELECT id, occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp < 0
         AND note LIKE 'import:cartola|%'
       ORDER BY occurred_on DESC, id DESC`
    )
    .all(accountId) as {
    id: number;
    occurred_on: string;
    amount_clp: number;
    note: string | null;
  }[];

  const internalMcMonths = computeMercadoCapitalesInternalTransferMonths(accountId, deposits, {
    checkingWithdrawals: rows,
    checkingCredits,
  });

  const lines: FlowCcExpenseLineRowDraft[] = [];
  const usedDepositKeys = new Set<string>();

  const pushCheckingLine = (
    row: (typeof rows)[number],
    amountClp: number,
    expenseMonth: string,
    description: string,
    opts: {
      matchedDeposit?: DepositMatchCandidate | null;
      autoMatchCategorySlug?: string;
      purchasePortion?: "gastos" | "deposit";
      autoMatchedDeposits?: DepositMatchAllocation[];
    } = {}
  ) => {
    if (amountClp <= 0) return;
    const merchantKey = normalizeCcExpenseMerchantKey(description);
    const purchaseKey = checkingGastosMovementPurchaseKey(
      row.id,
      opts.purchasePortion ?? "gastos"
    );
    let categorySlug = resolveCcExpenseCategorySlug({
      statementLineId: row.id,
      accountId,
      merchantKey,
      purchaseKey,
      lineOverrides: new Map(),
      merchantRules,
      uniquePurchases,
    });
    const purchaseMapKey = `${accountId}|${purchaseKey}`;
    const userClearedUnique = userClearedUniqueAtLoad.has(purchaseMapKey);
    const persistedCategorySlug = uniquePurchases.get(purchaseMapKey);
    const userAssignedCategorySlug =
      persistedCategorySlug != null &&
      !isCcExpenseTotalsExcludedSlug(persistedCategorySlug);
    const matchedDeposit = opts.matchedDeposit ?? null;

    let derivedAutoMatchSlug: string | null = null;
    if (opts.autoMatchCategorySlug) {
      derivedAutoMatchSlug = opts.autoMatchCategorySlug;
    } else if (opts.autoMatchedDeposits != null && opts.autoMatchedDeposits.length > 0) {
      derivedAutoMatchSlug = autoMatchCategorySlugForAllocations(opts.autoMatchedDeposits);
    } else if (matchedDeposit != null) {
      derivedAutoMatchSlug = autoMatchCategorySlugForDeposit(matchedDeposit);
    }

    const gateAllowsAutoMatch =
      isCheckingCorrienteVistaTraspasoOutflow(description) ||
      checkingWithdrawalMayAutoMatchDeposit(description);

    const isAutoExcludedMatch =
      !userClearedUnique &&
      !userAssignedCategorySlug &&
      gateAllowsAutoMatch &&
      derivedAutoMatchSlug != null &&
      isCcExpenseTotalsExcludedSlug(derivedAutoMatchSlug);

    if (isAutoExcludedMatch && derivedAutoMatchSlug != null) {
      categorySlug = derivedAutoMatchSlug;
    }

    registerGenericUniquePurchaseMode(
      accountId,
      purchaseKey,
      merchantKey,
      uniquePurchaseModeKeys,
      { statementLineId: row.id }
    );

    let categoryUnique = categoryUniqueForExpenseLine(
      accountId,
      purchaseKey,
      merchantKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    );
    if (isAutoExcludedMatch) {
      const autoCat = getCcExpenseCategoryBySlug(categorySlug);
      registerUniquePurchaseMode(
        accountId,
        purchaseKey,
        autoCat?.id ?? null,
        uniquePurchaseModeKeys
      );
      categoryUnique = true;
    }
    let autoDepositMatchNote: string | undefined;
    if (isAutoExcludedMatch) {
      const allocations =
        opts.autoMatchedDeposits ??
        (matchedDeposit != null
          ? [{ deposit: matchedDeposit, amount_clp: amountClp }]
          : []);
      const note = formatAutoDepositMatchNote(allocations);
      if (note) autoDepositMatchNote = note;
    }
    lines.push({
      source: "checking",
      statement_line_id: row.id,
      account_id: accountId,
      expense_month: expenseMonth,
      billing_month: expenseMonth,
      purchase_month: expenseMonth,
      line_role: "purchase",
      occurred_on: row.occurred_on,
      purchase_on: row.occurred_on,
      statement_date: "",
      amount_clp: amountClp,
      amount_usd: null,
      amount_usd_at_expense: expenseGastosAmountUsdAtDate(amountClp, null, row.occurred_on),
      merchant: description || null,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      merchant_key: merchantKey,
      category_slug: categorySlug,
      category_unique: categoryUnique,
      origin_card_last4: null,
      primary_card_last4: null,
      ...(opts.purchasePortion === "deposit"
        ? { checking_purchase_portion: "deposit" as const }
        : {}),
      ...(autoDepositMatchNote ? { auto_deposit_match_note: autoDepositMatchNote } : {}),
    });
  };

  for (const row of [...rows].reverse()) {
    const description = cartolaDescriptionFromNote(row.note);
    if (isExcludedCheckingWithdrawal(description)) continue;
    if (
      withdrawalIsReversedByDapAbono(
        { occurred_on: row.occurred_on, amount_clp: row.amount_clp, note: row.note },
        checkingCredits
      )
    ) {
      continue;
    }

    const expenseMonth = monthKeyFromYmd(row.occurred_on);
    if (!expenseMonth) continue;
    if (
      internalMcMonths.has(expenseMonth) &&
      isMercadoCapitalesCargoDescription(description)
    ) {
      continue;
    }

    const useDepositSplit =
      !isMercadoCapitalesCargoDescription(description) &&
      !LONG_NUMERIC_CARGO_REF_RE.test(description.replace(/\s/g, ""));

    const withdrawal = {
      occurred_on: row.occurred_on,
      amount_clp: row.amount_clp,
      description,
    };

    if (isCheckingCorrienteVistaTraspasoOutflow(description)) {
      const fullAbs = Math.round(Math.abs(row.amount_clp));
      const split = splitCheckingWithdrawalAgainstDeposits(withdrawal, deposits, {
        splittablePool,
        usedDepositKeys,
        withdrawalAccountId: accountId,
        withdrawalCategorySlug,
      });
      pushCheckingLine(row, fullAbs, expenseMonth, description, {
        autoMatchCategorySlug: CHECKING_INTERNAL_TRANSFER_CC_EXPENSE_SLUG,
        purchasePortion: "deposit",
        autoMatchedDeposits:
          split.internalMatchedDeposits.length > 0 ? split.internalMatchedDeposits : undefined,
      });
      continue;
    }

    if (useDepositSplit) {
      const split = splitCheckingWithdrawalAgainstDeposits(withdrawal, deposits, {
        splittablePool,
        usedDepositKeys,
        withdrawalAccountId: accountId,
        withdrawalCategorySlug,
      });
      if (split.gastosClp <= 0 && split.internalClp <= 0) continue;

      if (split.internalClp > 0) {
        pushCheckingLine(row, split.internalClp, expenseMonth, description, {
          purchasePortion: "deposit",
          autoMatchedDeposits: split.internalMatchedDeposits,
        });
      }
      if (split.gastosClp > 0) {
        pushCheckingLine(row, split.gastosClp, expenseMonth, description, {
          matchedDeposit: split.investmentDeposit,
          autoMatchedDeposits:
            split.investmentDeposit != null
              ? [
                  {
                    deposit: split.investmentDeposit,
                    amount_clp: split.investmentMatchClp,
                  },
                ]
              : undefined,
        });
      }
    } else {
      if (checkingOutflowIsAtmWithdrawal(description)) {
        pushCheckingLine(row, Math.round(Math.abs(row.amount_clp)), expenseMonth, description);
        continue;
      }
      const internalMatch = resolveInternalCashTransferMatch(
        withdrawal,
        deposits,
        splittablePool,
        3,
        accountId
      );
      if (internalMatch.matched) {
        const fullAbs = Math.round(Math.abs(row.amount_clp));
        pushCheckingLine(row, fullAbs, expenseMonth, description, {
          purchasePortion: "deposit",
          autoMatchedDeposits: internalMatch.allocations,
        });
        continue;
      }
      const matchedDeposit = matchWithdrawalToInvestmentDeposit(
        withdrawal,
        deposits,
        3,
        usedDepositKeys
      );
      if (matchedDeposit != null) {
        pushCheckingLine(row, Math.round(Math.abs(row.amount_clp)), expenseMonth, description, {
          matchedDeposit,
          autoMatchedDeposits: [
            { deposit: matchedDeposit, amount_clp: Math.round(Math.abs(row.amount_clp)) },
          ],
        });
        continue;
      }
      pushCheckingLine(row, Math.round(Math.abs(row.amount_clp)), expenseMonth, description);
    }
  }
  return lines;
}
