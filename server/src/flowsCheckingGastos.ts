import { monthKeyFromYmd } from "./calendarMonth.js";
import { checkingAccountId } from "./checkingCartolaImport.js";
import { checkingCartolaStablePurchaseKey } from "./checkingCartolaParse.js";
import {
  legacyCheckingGastosPurchaseKey,
  parseLegacyCheckingGastosPurchaseKey,
} from "./checkingGastosCategoryPersist.js";
import { isMovementBalanceCashCategory, listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { db } from "./db.js";
import {
  getCcExpenseCategoryBySlug,
  categoryUniqueForExpenseLine,
  isCcExpenseTotalsExcludedSlug,
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
import {
  formatAutoDepositMatchNote,
  type DepositMatchAllocation,
} from "./ccExpenseDepositMatchNotes.js";
import type { FlowCcExpenseLineRowDraft } from "./flowsCreditCardExpenses.js";
import { expenseGastosAmountUsdAtDate } from "./flowMoneyAtDate.js";
import {
  CHECKING_CORRIENTE_INTERNET_TRANSFER_RE,
  CHECKING_GASTOS_CASH_GROUP,
  DAP_ABONO_MAX_DAY_GAP,
  cartolaDescriptionFromNote,
  cartolaDocsMatchForDapAbono,
  cartolaDocumentFromNote,
  checkingCreditLooksLikeFintualIncomingWire,
  checkingCreditLooksLikeMonthBucketCashReturn,
  checkingCreditMayAutoMatchNetWorthCapitalReturn,
  checkingOutflowIsAtmWithdrawal,
  checkingWithdrawalFundsInvestmentCapital,
  checkingWithdrawalMayAutoMatchDeposit,
  dapAbonoAmountMatchesCargo,
  dapReferenceFromDescription,
  daysBetweenYmd,
  isCheckingCorrienteVistaTraspasoOutflow,
  isCheckingGastosWithdrawalNote,
  isDapReturnCreditDescription,
  isExcludedCheckingWithdrawal,
  isInvestmentDepositTarget,
  LONG_NUMERIC_CARGO_REF_RE,
  isMercadoCapitalesCargoDescription,
  isPayrollRemuneracionCartolaCredit,
  signedDaysFromTo,
  stripCheckingBranchPrefix,
  withdrawalMayUseSplittableReservaPool,
} from "./checkingDescriptionPredicates.js";
import {
  checkingGastosAccountCategorySlug,
  loadCheckingCartolaCredits,
  loadCheckingCartolaWithdrawals,
  loadCheckingGastosWithdrawalRows,
  loadDepositMatchCandidates,
  loadMovementBalanceCashCartolaCredits,
  type CheckingCartolaCredit,
  type CheckingCartolaWithdrawal,
  type CheckingCartolaWithdrawalWithAccount,
  type DepositMatchCandidate,
} from "./checkingCartolaLoaders.js";

export type { DepositMatchAllocation };

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
  if (!isCheckingGastosWithdrawalNote(note)) {
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
  // Hoist: property narrowing does not survive into the transaction closure below.
  const accountId = belong.account_id;

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
          upsertUniquePurchase.run(accountId, key, null);
        }
      } else {
        for (const key of purchaseKeys) {
          delUniquePurchase.run(accountId, key);
        }
        for (const ruleKey of merchantRuleKeysMatchingLineMerchant(accountId, merchantKey)) {
          delMerchant.run(accountId, ruleKey);
        }
      }
      return;
    }

    if (opts.unique) {
      for (const key of purchaseKeys) {
        delUniquePurchase.run(accountId, key);
      }
      upsertUniquePurchase.run(belong.account_id, purchaseKey, catId);
    } else {
      for (const key of purchaseKeys) {
        delUniquePurchase.run(accountId, key);
      }
      if (catId != null && merchantKey) {
        upsertMerchant.run(accountId, merchantKey, catId);
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

/** Day-gap for exact-date ledger retiros; month-bucket accounts use calendar month only. */
export function ledgerCapitalReturnMatchesTiming(
  creditOccurredOn: string,
  outflowOccurredOn: string,
  outflowCategorySlug: string,
  maxDayGap: number
): boolean {
  if (MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(outflowCategorySlug)) {
    const creditMonth = monthKeyFromYmd(creditOccurredOn);
    const outflowMonth = monthKeyFromYmd(outflowOccurredOn);
    return creditMonth != null && creditMonth === outflowMonth;
  }
  const dayGap = signedDaysFromTo(outflowOccurredOn, creditOccurredOn);
  return dayGap >= 0 && dayGap <= maxDayGap;
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
  if (isPayrollRemuneracionCartolaCredit(credit)) return false;
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
      // Corriente→vista traspaso: outflow on A pairs with inflow on B. A same-day
      // external abono on A (e.g. REMUNERACION) must not be excluded — only B's inflow.
      if (row.account_id === creditAccountId) continue;
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

function checkingWithdrawalPairKey(row: {
  account_id: number;
  occurred_on: string;
  amount_clp: number;
}): string {
  return `${row.account_id}|${row.occurred_on}|${Math.round(Math.abs(row.amount_clp))}`;
}

export function netWorthCapitalLedgerOutflowPairKey(o: DepositMatchCandidate): string {
  return `${o.account_id}|${o.occurred_on}|${o.amount_clp}`;
}

function checkingCreditMatchesCheckingOutflowCapitalReturn(
  credit: { occurred_on: string; amount_clp: number; note?: string | null },
  checkingWithdrawals: readonly CheckingCartolaWithdrawalWithAccount[],
  opts: {
    maxDayGap: number;
    consumedWithdrawalKeys?: Set<string>;
  }
): boolean {
  const want = Math.round(credit.amount_clp);
  const description =
    credit.note != null ? cartolaDescriptionFromNote(credit.note) : "";
  if (!checkingCreditMayAutoMatchNetWorthCapitalReturn(description)) return false;

  for (const withdrawal of checkingWithdrawals) {
    if (Math.round(Math.abs(withdrawal.amount_clp)) !== want) continue;
    if (!checkingWithdrawalFundsInvestmentCapital(withdrawal.note)) continue;
    const dayGap = signedDaysFromTo(withdrawal.occurred_on, credit.occurred_on);
    if (dayGap < 0 || dayGap > opts.maxDayGap) continue;
    const key = checkingWithdrawalPairKey(withdrawal);
    if (opts.consumedWithdrawalKeys?.has(key)) continue;
    opts.consumedWithdrawalKeys?.add(key);
    return true;
  }
  return false;
}

/** Fintual incoming wire paired with a brokerage/retirement ledger retiro (not AFP). */
export function checkingCreditMatchesLedgerNetWorthCapitalReturn(
  credit: { occurred_on: string; amount_clp: number; note?: string | null },
  ledgerOutflows: readonly DepositMatchCandidate[],
  opts?: {
    maxDayGap?: number;
    consumedLedgerOutflowKeys?: Set<string>;
  }
): boolean {
  const maxDayGap = opts?.maxDayGap ?? NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP;
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  const description =
    credit.note != null ? cartolaDescriptionFromNote(credit.note) : "";
  if (!checkingCreditLooksLikeFintualIncomingWire(description)) return false;

  return ledgerNetWorthCapitalReturnMatchesAmount(
    credit.occurred_on,
    want,
    ledgerOutflows,
    maxDayGap,
    opts?.consumedLedgerOutflowKeys
  );
}

export type FintualIncomingWireBatch = {
  key: string;
  account_id: number;
  occurred_on: string;
  movement_ids: number[];
  total_clp: number;
};

function fintualIncomingWireBatchGroupKey(credit: {
  account_id: number;
  occurred_on: string;
  note: string | null;
}): string | null {
  const description = cartolaDescriptionFromNote(credit.note);
  if (!checkingCreditLooksLikeFintualIncomingWire(description)) return null;
  const descKey = normalizeCcExpenseMerchantKey(description.trim());
  const doc = cartolaDocumentFromNote(credit.note);
  return `${credit.account_id}|${credit.occurred_on}|${descKey}|${doc ?? ""}`;
}

/** Same-day split Fintual wires (e.g. 3M + 7M) that sum to one ledger retiro. */
export function buildFintualIncomingWireBatches(
  credits: readonly {
    movement_id: number;
    account_id: number;
    occurred_on: string;
    amount_clp: number;
    note: string | null;
  }[]
): {
  batches: FintualIncomingWireBatch[];
  batchByMovementId: Map<number, FintualIncomingWireBatch>;
} {
  const byKey = new Map<string, FintualIncomingWireBatch>();
  for (const credit of credits) {
    const key = fintualIncomingWireBatchGroupKey(credit);
    if (key == null) continue;
    let batch = byKey.get(key);
    if (batch == null) {
      batch = {
        key,
        account_id: credit.account_id,
        occurred_on: credit.occurred_on,
        movement_ids: [],
        total_clp: 0,
      };
      byKey.set(key, batch);
    }
    batch.movement_ids.push(credit.movement_id);
    batch.total_clp += Math.round(credit.amount_clp);
  }
  const batches = [...byKey.values()].filter((b) => b.movement_ids.length >= 2);
  const batchByMovementId = new Map<number, FintualIncomingWireBatch>();
  for (const batch of batches) {
    for (const movementId of batch.movement_ids) {
      batchByMovementId.set(movementId, batch);
    }
  }
  return { batches, batchByMovementId };
}

function ledgerNetWorthCapitalReturnMatchesAmount(
  creditOccurredOn: string,
  wantClp: number,
  ledgerOutflows: readonly DepositMatchCandidate[],
  maxDayGap: number,
  consumedLedgerOutflowKeys?: Set<string>
): boolean {
  if (wantClp <= 0) return false;
  for (const outflow of ledgerOutflows) {
    if (outflow.category_slug === "afp") continue;
    if (MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(outflow.category_slug)) continue;
    if (Math.round(outflow.amount_clp) !== wantClp) continue;
    if (
      !ledgerCapitalReturnMatchesTiming(
        creditOccurredOn,
        outflow.occurred_on,
        outflow.category_slug,
        maxDayGap
      )
    ) {
      continue;
    }
    const key = netWorthCapitalLedgerOutflowPairKey(outflow);
    if (consumedLedgerOutflowKeys?.has(key)) continue;
    consumedLedgerOutflowKeys?.add(key);
    return true;
  }
  return false;
}

/** Depósito en Efectivo paired with a month-end cuenta ahorro ledger retiro (same month). */
export function checkingCreditMatchesMonthBucketLedgerCapitalReturn(
  credit: { occurred_on: string; amount_clp: number; note?: string | null },
  ledgerOutflows: readonly DepositMatchCandidate[],
  opts?: {
    maxDayGap?: number;
    consumedLedgerOutflowKeys?: Set<string>;
  }
): boolean {
  const maxDayGap = opts?.maxDayGap ?? NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP;
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;
  const description =
    credit.note != null ? cartolaDescriptionFromNote(credit.note) : "";
  if (!checkingCreditLooksLikeMonthBucketCashReturn(description)) return false;

  for (const outflow of ledgerOutflows) {
    if (!MONTH_BUCKET_INTERNAL_TRANSFER_CATEGORIES.has(outflow.category_slug)) continue;
    if (Math.round(outflow.amount_clp) !== want) continue;
    if (
      !ledgerCapitalReturnMatchesTiming(
        credit.occurred_on,
        outflow.occurred_on,
        outflow.category_slug,
        maxDayGap
      )
    ) {
      continue;
    }
    const key = netWorthCapitalLedgerOutflowPairKey(outflow);
    if (opts?.consumedLedgerOutflowKeys?.has(key)) continue;
    opts?.consumedLedgerOutflowKeys?.add(key);
    return true;
  }
  return false;
}

export function checkingFintualIncomingWireBatchMatchesLedgerNetWorthCapitalReturn(
  batch: FintualIncomingWireBatch,
  ledgerOutflows: readonly DepositMatchCandidate[],
  opts?: {
    maxDayGap?: number;
    consumedLedgerOutflowKeys?: Set<string>;
  }
): boolean {
  const maxDayGap = opts?.maxDayGap ?? NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP;
  return ledgerNetWorthCapitalReturnMatchesAmount(
    batch.occurred_on,
    batch.total_clp,
    ledgerOutflows,
    maxDayGap,
    opts?.consumedLedgerOutflowKeys
  );
}

/**
 * Checking abono that returns capital from investments.
 * Path A: generic abono + same-amount Fintual/reserva checking outflow within the window.
 * Path B: Fintual incoming wire description + same-amount brokerage/retirement ledger retiro.
 * Path C: Depósito en Efectivo + same-month cuenta ahorro month-end ledger retiro.
 */
export function checkingCreditMatchesNetWorthCapitalReturn(
  credit: { occurred_on: string; amount_clp: number; note?: string | null },
  checkingWithdrawals: readonly CheckingCartolaWithdrawalWithAccount[],
  opts?: {
    maxDayGap?: number;
    consumedWithdrawalKeys?: Set<string>;
    ledgerOutflows?: readonly DepositMatchCandidate[];
    consumedLedgerOutflowKeys?: Set<string>;
  }
): boolean {
  const maxDayGap = opts?.maxDayGap ?? NET_WORTH_CAPITAL_RETURN_MAX_DAY_GAP;
  const want = Math.round(credit.amount_clp);
  if (want <= 0) return false;

  if (
    checkingCreditMatchesCheckingOutflowCapitalReturn(credit, checkingWithdrawals, {
      maxDayGap,
      consumedWithdrawalKeys: opts?.consumedWithdrawalKeys,
    })
  ) {
    return true;
  }
  if (opts?.ledgerOutflows == null) return false;
  if (
    checkingCreditMatchesMonthBucketLedgerCapitalReturn(credit, opts.ledgerOutflows, {
      maxDayGap,
      consumedLedgerOutflowKeys: opts.consumedLedgerOutflowKeys,
    })
  ) {
    return true;
  }
  return checkingCreditMatchesLedgerNetWorthCapitalReturn(credit, opts.ledgerOutflows, {
    maxDayGap,
    consumedLedgerOutflowKeys: opts.consumedLedgerOutflowKeys,
  });
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
/** Fintual (fondo reserva) credits the deposit up to a few days after the wire leaves checking, so
 *  the splittable pool can't require an exact same-date match. Exact amount still gates the pairing. */
const SPLITTABLE_INTERNAL_TRANSFER_MAX_DAY_GAP = 8;

function depositMatchesSplittableInternalTransferTiming(
  withdrawal: { occurred_on: string },
  deposit: Pick<DepositMatchCandidate, "occurred_on">
): boolean {
  return (
    daysBetweenYmd(deposit.occurred_on, withdrawal.occurred_on) <=
    SPLITTABLE_INTERNAL_TRANSFER_MAX_DAY_GAP
  );
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
  withdrawalAccountId: number,
  usedDepositKeys?: Set<string>
): DepositMatchCandidate | null {
  const want = Math.round(Math.abs(withdrawal.amount_clp));
  if (want <= 0) return null;
  // Skip deposits already consumed by another outflow and prefer the closest date, so two
  // same-amount outflows pair 1:1 with two same-amount deposits (same-date first) instead of
  // both greedily claiming the earliest deposit.
  let best: DepositMatchCandidate | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const d of deposits) {
    if (d.group_slug !== CHECKING_GASTOS_CASH_GROUP) continue;
    if (!depositIsCrossAccountInternalTransfer(d, withdrawalAccountId)) continue;
    if (Math.round(d.amount_clp) !== want) continue;
    if (usedDepositKeys?.has(splittableDepositPoolKey(d))) continue;
    if (!depositMatchesInternalTransferTiming(withdrawal, d, maxDayGap)) continue;
    const gap = daysBetweenYmd(d.occurred_on, withdrawal.occurred_on);
    if (gap < bestGap) {
      best = d;
      bestGap = gap;
    }
  }
  return best;
}

function resolveInternalCashTransferMatch(
  withdrawal: { occurred_on: string; amount_clp: number; description?: string },
  deposits: readonly DepositMatchCandidate[],
  splittablePool: Map<string, number>,
  maxDayGap: number,
  withdrawalAccountId: number,
  usedDepositKeys?: Set<string>
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
      withdrawalAccountId,
      usedDepositKeys
    );
    if (exact != null) {
      usedDepositKeys?.add(splittableDepositPoolKey(exact));
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
        opts.withdrawalAccountId,
        opts.usedDepositKeys
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

  const rows = loadCheckingGastosWithdrawalRows(accountId);

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
      uniquePurchaseModeKeys,
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
    if (isExcludedCheckingWithdrawal(description)) {
      // Fintual / reserva investment-funding transfers are excluded from the gastos list, but must
      // still emit their deposit-portion line so the funded net-worth deposit gets linked through the
      // SAME matcher + shared pool as every other deposit (no parallel post-pass; the shared pool also
      // stops two same-amount outflows from both claiming one deposit). Other exclusions stay dropped.
      const em = monthKeyFromYmd(row.occurred_on);
      if (em && checkingWithdrawalFundsInvestmentCapital(row.note)) {
        const split = splitCheckingWithdrawalAgainstDeposits(
          { occurred_on: row.occurred_on, amount_clp: row.amount_clp, description },
          deposits,
          { splittablePool, usedDepositKeys, withdrawalAccountId: accountId, withdrawalCategorySlug }
        );
        if (split.internalClp > 0) {
          pushCheckingLine(row, split.internalClp, em, description, {
            purchasePortion: "deposit",
            autoMatchedDeposits: split.internalMatchedDeposits,
          });
        }
        if (split.investmentDeposit != null && split.investmentMatchClp > 0) {
          pushCheckingLine(row, split.investmentMatchClp, em, description, {
            matchedDeposit: split.investmentDeposit,
            autoMatchedDeposits: [
              { deposit: split.investmentDeposit, amount_clp: split.investmentMatchClp },
            ],
          });
        }
      }
      continue;
    }
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
        accountId,
        usedDepositKeys
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
