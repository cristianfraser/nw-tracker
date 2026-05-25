import { NOTE_STOCKS_LEGACY } from "./brokerageAcciones.js";
import { loadMergedDepositInflowEvents } from "./accountDeposits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import {
  isMovementBalanceCashCategory,
  listMovementBalanceCashAccountIds,
} from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import {
  getCcExpenseCategoryBySlug,
  lineHasUniquePurchaseMode,
  loadCcExpenseCategoryMaps,
  normalizeCcExpenseMerchantKey,
  merchantRuleKeysMatchingLineMerchant,
  resolveCcExpenseCategorySlug,
  UNCLASSIFIED_CC_EXPENSE_SLUG,
  DEPOSITS_CC_EXPENSE_SLUG,
} from "./ccExpenseCategories.js";
import { isCcPaymentMerchant } from "./ccPaymentLines.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";

/** Asset group for cash / efectivo accounts (internal transfer targets from checking). */
export const CHECKING_GASTOS_CASH_GROUP = "cash_eqs";

const INVESTMENT_DEPOSIT_GROUPS = new Set(["real_estate", "brokerage", "retirement"]);

export function isInvestmentDepositTarget(groupSlug: string): boolean {
  return INVESTMENT_DEPOSIT_GROUPS.has(groupSlug);
}

export function checkingGastosMovementPurchaseKey(movementId: number): string {
  return `checking-mv:${movementId}`;
}

export function checkingGastosMovementBelongs(movementId: number): {
  ok: boolean;
  account_id?: number;
  merchant_key?: string;
} {
  let checkingId: number;
  try {
    checkingId = checkingAccountId();
  } catch {
    return { ok: false };
  }

  const row = db
    .prepare(
      `SELECT account_id, occurred_on, amount_clp, note
       FROM movements
       WHERE id = ?`
    )
    .get(movementId) as
    | { account_id: number; occurred_on: string; amount_clp: number; note: string | null }
    | undefined;

  if (!row || row.account_id !== checkingId || row.amount_clp >= 0) {
    return { ok: false };
  }

  const note = String(row.note ?? "").trim();
  if (!note.startsWith("import:cartola|") || note.startsWith("import:checking-synthetic|")) {
    return { ok: false };
  }

  const description = cartolaDescriptionFromNote(row.note);
  if (isExcludedCheckingWithdrawal(description)) {
    return { ok: false };
  }
  const depositCandidates = loadDepositMatchCandidates();
  const split = splitCheckingWithdrawalAgainstDeposits(
    { occurred_on: row.occurred_on, amount_clp: row.amount_clp },
    depositCandidates,
    {
      splittablePool: createSplittableInternalTransferPool(depositCandidates),
      usedDepositKeys: new Set<string>(),
    }
  );
  if (split.gastosClp <= 0) {
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
  const internalMcMonths = computeMercadoCapitalesInternalTransferMonths(checkingId, deposits);
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
    account_id: checkingId,
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
      delUniquePurchase.run(belong.account_id, purchaseKey);
      for (const ruleKey of merchantRuleKeysMatchingLineMerchant(belong.account_id, merchantKey)) {
        delMerchant.run(belong.account_id, ruleKey);
      }
      return;
    }

    if (opts.unique) {
      delUniquePurchase.run(belong.account_id, purchaseKey);
      upsertUniquePurchase.run(belong.account_id, purchaseKey, catId);
    } else {
      delUniquePurchase.run(belong.account_id, purchaseKey);
      if (catId != null && merchantKey) {
        upsertMerchant.run(belong.account_id, merchantKey, catId);
      }
    }
  });
  tx();

  if (opts.clearCategory) {
    return {
      category_slug: UNCLASSIFIED_CC_EXPENSE_SLUG,
      unique: false,
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
  const docIdx = desc.lastIndexOf("|doc:");
  if (docIdx >= 0) desc = desc.slice(0, docIdx).trim();
  else if (desc.startsWith("doc:")) desc = "";
  return desc;
}

/** Document number from `import:cartola|…|description|doc:NNNN`. */
export function cartolaDocumentFromNote(note: string | null | undefined): string | null {
  const n = String(note ?? "").trim();
  const idx = n.lastIndexOf("|doc:");
  if (idx < 0) return null;
  const doc = n.slice(idx + "|doc:".length).trim();
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
         AND note NOT LIKE 'import:checking-synthetic|%'
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
         AND note NOT LIKE 'import:checking-synthetic|%'
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
  const d = description.trim();
  if (!d) return true;
  if (INTERNAL_TRANSFER_RE.test(d)) return true;
  if (isCcPaymentMerchant(d)) return true;
  if (CC_PAYMENT_DESC_RE.test(d)) return true;
  if (OWN_SANTANDER_TRANSFER_RE.test(d)) return true;
  if (CUENTA_VISTA_TRANSFER_DESC_RE.test(d)) return true;
  if (RESERVA_TRANSFER_DESC_RE.test(d)) return true;
  return false;
}

export function fondoReservaAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN categories c ON c.id = a.category_id
       WHERE c.slug = 'fondo_reserva'
       LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

function listDepositFlowAccounts(): { account_id: number; category_slug: string; group_slug: string }[] {
  return db
    .prepare(
      `SELECT a.id AS account_id, c.slug AS category_slug, g.slug AS group_slug
       FROM accounts a
       JOIN categories c ON c.id = a.category_id
       JOIN asset_groups g ON g.id = c.group_id
       WHERE (a.notes IS NULL OR a.notes != ?)
         AND COALESCE(a.exclude_from_group_totals, 0) = 0
         AND g.slug IN ('real_estate', 'cash_eqs', 'brokerage', 'retirement')
         AND (g.slug != 'brokerage' OR c.slug != 'individual_stocks')`
    )
    .all(NOTE_STOCKS_LEGACY) as { account_id: number; category_slug: string; group_slug: string }[];
}

function withdrawalMatchesInternalCashTransferExact(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap: number
): boolean {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) return false;
  for (const d of deposits) {
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (d.category_slug === "cuenta_corriente") continue;
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
): number {
  const cap = Math.round(maxTake);
  if (cap <= 0) return 0;
  for (const d of deposits) {
    if (!SPLITTABLE_INTERNAL_TRANSFER_CATEGORIES.has(d.category_slug)) continue;
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (!depositMatchesSplittableInternalTransferTiming(withdrawal, d)) continue;
    const key = splittableDepositPoolKey(d);
    const poolRemaining = pool.get(key);
    if (poolRemaining == null || poolRemaining <= 0) continue;
    const take = Math.min(cap, poolRemaining);
    pool.set(key, poolRemaining - take);
    return take;
  }
  return 0;
}

function tryAllocateSplittableInternalTransfer(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  pool: Map<string, number>
): boolean {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  return tryAllocateSplittableInternalTransferAmount(withdrawal, deposits, pool, want) === want;
}

export type CheckingWithdrawalDepositSplit = {
  internalClp: number;
  investmentDeposit: DepositMatchCandidate | null;
  gastosClp: number;
};

/** Splits a checking outflow across internal cash and investment deposits; remainder is gastos. */
export function splitCheckingWithdrawalAgainstDeposits(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  opts: {
    splittablePool: Map<string, number>;
    usedDepositKeys: Set<string>;
    maxDayGap?: number;
  }
): CheckingWithdrawalDepositSplit {
  const maxDayGap = opts.maxDayGap ?? 3;
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) {
    return { internalClp: 0, investmentDeposit: null, gastosClp: 0 };
  }

  let internalClp = 0;
  let remaining = want;

  if (withdrawalMatchesInternalCashTransferExact(withdrawal, deposits, maxDayGap)) {
    for (const d of deposits) {
      if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP || d.category_slug === "cuenta_corriente") continue;
      if (Math.round(d.amount_clp) !== want) continue;
      if (!depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)) continue;
      opts.usedDepositKeys.add(splittableDepositPoolKey(d));
      break;
    }
    return { internalClp: want, investmentDeposit: null, gastosClp: 0 };
  }

  // Month-bucket cash accounts (ahorro vivienda) only pair on exact amount — not greedy partials.
  const partialInternal = deposits
    .filter(
      (d) =>
        d.group_slug === CHECKING_GASTOS_CASH_GROUP &&
        d.category_slug !== "cuenta_corriente" &&
        !MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(d.category_slug) &&
        depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)
    )
    .sort((a, b) => b.amount_clp - a.amount_clp);

  for (const d of partialInternal) {
    if (remaining <= 0) break;
    const key = splittableDepositPoolKey(d);
    const depAmt = Math.round(d.amount_clp);
    if (depAmt <= 0 || depAmt > remaining || opts.usedDepositKeys.has(key)) continue;
    opts.usedDepositKeys.add(key);
    remaining -= depAmt;
    internalClp += depAmt;
  }

  if (remaining > 0) {
    const fromPool = tryAllocateSplittableInternalTransferAmount(
      withdrawal,
      deposits,
      opts.splittablePool,
      remaining
    );
    internalClp += fromPool;
    remaining = want - internalClp;
  }

  const investmentDeposit =
    remaining > 0
      ? matchWithdrawalToInvestmentDeposit(
          { occurred_on: withdrawal.occurred_on, amount_clp: -remaining },
          deposits,
          maxDayGap,
          opts.usedDepositKeys
        )
      : null;

  if (investmentDeposit != null) {
    opts.usedDepositKeys.add(splittableDepositPoolKey(investmentDeposit));
  }

  return { internalClp, investmentDeposit, gastosClp: remaining };
}

/** Checking outflow that pairs with an inflow on another cash/efectivo account (internal transfer). */
export function withdrawalMatchesInternalCashTransfer(
  withdrawal: { occurred_on: string; amount_clp: number },
  deposits: readonly DepositMatchCandidate[],
  maxDayGap = 3,
  splittablePool?: Map<string, number>
): boolean {
  if (withdrawalMatchesInternalCashTransferExact(withdrawal, deposits, maxDayGap)) return true;
  if (splittablePool == null) return false;
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
  const investment = deposits.filter((d) => isInvestmentDepositTarget(d.group_slug));
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
  depositCandidates?: readonly DepositMatchCandidate[];
  checkingCredits?: readonly CheckingCartolaCredit[];
  merchantRules?: Map<string, string>;
  uniquePurchases?: Map<string, string>;
  uniquePurchaseModeKeys?: Set<string>;
}): FlowCcExpenseLineRowDraft[] {
  const accountId = checkingAccountId();
  const deposits = opts?.depositCandidates ?? loadDepositMatchCandidates();
  const splittablePool = createSplittableInternalTransferPool(deposits);
  const checkingCredits = opts?.checkingCredits ?? loadMovementBalanceCashCartolaCredits();
  const categoryMaps =
    opts?.merchantRules != null
      ? {
          merchantRules: opts.merchantRules,
          uniquePurchases: opts.uniquePurchases ?? new Map<string, string>(),
          uniquePurchaseModeKeys: opts.uniquePurchaseModeKeys ?? new Set<string>(),
        }
      : loadCcExpenseCategoryMaps([accountId]);
  const { merchantRules, uniquePurchases, uniquePurchaseModeKeys } = categoryMaps;

  const rows = db
    .prepare(
      `SELECT id, occurred_on, amount_clp, note
       FROM movements
       WHERE account_id = ?
         AND amount_clp < 0
         AND note LIKE 'import:cartola|%'
         AND note NOT LIKE 'import:checking-synthetic|%'
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

    let amountClp: number;
    let matchedDeposit: DepositMatchCandidate | null;
    if (useDepositSplit) {
      const split = splitCheckingWithdrawalAgainstDeposits(
        { occurred_on: row.occurred_on, amount_clp: row.amount_clp },
        deposits,
        { splittablePool, usedDepositKeys }
      );
      if (split.gastosClp <= 0) continue;
      amountClp = split.gastosClp;
      matchedDeposit = split.investmentDeposit;
    } else {
      if (
        withdrawalMatchesInternalCashTransfer(
          { occurred_on: row.occurred_on, amount_clp: row.amount_clp },
          deposits,
          3,
          splittablePool
        )
      ) {
        continue;
      }
      amountClp = Math.round(Math.abs(row.amount_clp));
      matchedDeposit = matchWithdrawalToInvestmentDeposit(
        { occurred_on: row.occurred_on, amount_clp: row.amount_clp },
        deposits,
        3,
        usedDepositKeys
      );
    }
    const merchantKey = normalizeCcExpenseMerchantKey(description);
    const purchaseKey = checkingGastosMovementPurchaseKey(row.id);
    let categorySlug = resolveCcExpenseCategorySlug({
      statementLineId: row.id,
      accountId,
      merchantKey,
      purchaseKey,
      lineOverrides: new Map(),
      merchantRules,
      uniquePurchases,
    });
    if (
      categorySlug === UNCLASSIFIED_CC_EXPENSE_SLUG &&
      matchedDeposit != null
    ) {
      categorySlug = DEPOSITS_CC_EXPENSE_SLUG;
    }
    const categoryUnique = lineHasUniquePurchaseMode(
      accountId,
      purchaseKey,
      uniquePurchases,
      uniquePurchaseModeKeys
    );

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
      merchant: description || null,
      installment_flag: 0,
      nro_cuota_current: null,
      nro_cuota_total: null,
      merchant_key: merchantKey,
      category_slug: categorySlug,
      category_unique: categoryUnique,
    });
  }
  return lines;
}
