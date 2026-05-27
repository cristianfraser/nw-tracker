import { monthKeyFromYmd } from "./calendarMonth.js";
import { addCalendarMonths } from "./ccYearMonth.js";
import { countsTowardCcExpenseGastosMes } from "./ccExpenseCategories.js";
import { lineCountsTowardGastosSum } from "./ccExpensePeriodMonth.js";
import { purchaseCountsAfterNotaPairing } from "./ccNotaDeCreditoPairing.js";
import { db } from "./db.js";
import type { FlowCcExpenseLineRow } from "./flowsCreditCardExpenses.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import {
  merchantMatchesExpectation,
  type RealEstateApartmentSlug,
} from "./realEstateExpenseMerchants.js";

const GASTOS_INSTALLMENT_MODE = "split" as const;

/** Bill month X may be paid same month (X+0) or on the card in X+1 / X+2. */
export const REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MIN = 0;
export const REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX = 2;

export type ExpenseExpectationRow = {
  id: number;
  amount_clp: number;
  spent_on: string;
  category: string | null;
  note: string | null;
  expense_account_id: number;
  account_slug: RealEstateApartmentSlug;
};

export type RealEstateLinkRow = {
  expense_entry_id: number;
  purchase_key: string;
  link_source: "auto" | "manual";
};

export function isGastosLineEligibleForRealEstateLink(line: FlowCcExpenseLineRow): boolean {
  if (line.nota_credito_role === "annulled_purchase" || line.nota_credito_role === "matched_nota") {
    return false;
  }
  if (line.nota_credito_role === "unmatched_nota") return false;
  if (line.amount_clp <= 0) return false;
  const countsCategory = countsTowardCcExpenseGastosMes(line.category_slug, {
    installment_flag: line.installment_flag,
    nro_cuota_current: line.nro_cuota_current,
  });
  if (!countsCategory) return false;
  if (!purchaseCountsAfterNotaPairing(line)) return false;
  if (!lineCountsTowardGastosSum(line, GASTOS_INSTALLMENT_MODE, countsCategory)) return false;
  return true;
}

export function loadGastosLinesForRealEstateMatching(): FlowCcExpenseLineRow[] {
  const payload = buildFlowsCreditCardExpensesPayload();
  return payload.lines.filter(isGastosLineEligibleForRealEstateLink);
}

export function loadExistingLinks(): Map<number, RealEstateLinkRow> {
  const rows = db
    .prepare(
      `SELECT expense_entry_id, purchase_key, link_source FROM real_estate_expense_links`
    )
    .all() as RealEstateLinkRow[];
  return new Map(rows.map((r) => [r.expense_entry_id, r]));
}

export function loadLinkedPurchaseKeys(): Set<string> {
  const rows = db
    .prepare(`SELECT purchase_key FROM real_estate_expense_links`)
    .all() as { purchase_key: string }[];
  return new Set(rows.map((r) => r.purchase_key));
}

export function loadRejectionsForEntry(expenseEntryId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT purchase_key FROM real_estate_expense_link_rejections WHERE expense_entry_id = ?`
    )
    .all(expenseEntryId) as { purchase_key: string }[];
  return new Set(rows.map((r) => r.purchase_key));
}

export function loadAllRejections(): Map<number, Set<string>> {
  const rows = db
    .prepare(
      `SELECT expense_entry_id, purchase_key FROM real_estate_expense_link_rejections`
    )
    .all() as { expense_entry_id: number; purchase_key: string }[];
  const out = new Map<number, Set<string>>();
  for (const r of rows) {
    let set = out.get(r.expense_entry_id);
    if (!set) {
      set = new Set();
      out.set(r.expense_entry_id, set);
    }
    set.add(r.purchase_key);
  }
  return out;
}

export function billMonthFromSpentOn(spentOn: string): string {
  return monthKeyFromYmd(spentOn);
}

export function purchaseMonthForLine(line: FlowCcExpenseLineRow): string {
  if (line.purchase_on) return monthKeyFromYmd(line.purchase_on);
  return line.purchase_month || line.expense_month;
}

/** Calendar months from bill month through +2 where the card charge may appear. */
export function allowedPurchaseMonthsForBill(billMonth: string): string[] {
  const months: string[] = [];
  for (
    let delta = REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MIN;
    delta <= REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX;
    delta++
  ) {
    months.push(addCalendarMonths(billMonth, delta));
  }
  return months;
}

/** Months between bill month and purchase month; null if outside the allowed forward window. */
export function purchaseMonthOffsetFromBill(
  billMonth: string,
  purchaseMonth: string
): number | null {
  const [by, bm] = billMonth.split("-").map(Number);
  const [py, pm] = purchaseMonth.split("-").map(Number);
  if (!Number.isFinite(by) || !Number.isFinite(bm) || !Number.isFinite(py) || !Number.isFinite(pm)) {
    return null;
  }
  const offset = (py - by) * 12 + (pm - bm);
  if (
    offset < REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MIN ||
    offset > REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX
  ) {
    return null;
  }
  return offset;
}

export function purchaseMonthMatchesBillSlot(billMonth: string, purchaseMonth: string): boolean {
  return purchaseMonthOffsetFromBill(billMonth, purchaseMonth) != null;
}

function rankAutoLinkCandidates(
  expectation: ExpenseExpectationRow,
  candidates: readonly FlowCcExpenseLineRow[],
  billMonth: string
): FlowCcExpenseLineRow[] {
  return [...candidates].sort((a, b) => {
    const aMerchant = merchantMatchesExpectation(
      expectation.account_slug,
      expectation.category ?? "",
      a.merchant_key
    );
    const bMerchant = merchantMatchesExpectation(
      expectation.account_slug,
      expectation.category ?? "",
      b.merchant_key
    );
    if (aMerchant !== bMerchant) return aMerchant ? -1 : 1;
    const aOff =
      purchaseMonthOffsetFromBill(billMonth, purchaseMonthForLine(a)) ??
      REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX + 1;
    const bOff =
      purchaseMonthOffsetFromBill(billMonth, purchaseMonthForLine(b)) ??
      REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX + 1;
    return aOff - bOff;
  });
}

export function pickAutoLinkCandidate(
  expectation: ExpenseExpectationRow,
  candidates: readonly FlowCcExpenseLineRow[],
  billMonth: string
): FlowCcExpenseLineRow | null {
  if (expectation.amount_clp <= 0 || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0]!;

  const merchantMatches = candidates.filter((ln) =>
    merchantMatchesExpectation(
      expectation.account_slug,
      expectation.category ?? "",
      ln.merchant_key
    )
  );
  if (merchantMatches.length === 0) return null;
  if (merchantMatches.length === 1) return merchantMatches[0]!;

  const ranked = rankAutoLinkCandidates(expectation, merchantMatches, billMonth);
  const best = ranked[0]!;
  const bestOffset = purchaseMonthOffsetFromBill(billMonth, purchaseMonthForLine(best));
  const atBestOffset = ranked.filter(
    (ln) => purchaseMonthOffsetFromBill(billMonth, purchaseMonthForLine(ln)) === bestOffset
  );
  if (atBestOffset.length === 1) return best;
  return null;
}

export function findAmountMatchCandidates(
  expectation: ExpenseExpectationRow,
  gastosLines: readonly FlowCcExpenseLineRow[],
  linkedPurchaseKeys: ReadonlySet<string>,
  rejections: ReadonlySet<string>
): FlowCcExpenseLineRow[] {
  if (expectation.amount_clp <= 0) return [];
  const billMonth = billMonthFromSpentOn(expectation.spent_on);
  return gastosLines.filter(
    (ln) =>
      ln.amount_clp === expectation.amount_clp &&
      !linkedPurchaseKeys.has(ln.purchase_key) &&
      !rejections.has(ln.purchase_key) &&
      purchaseMonthMatchesBillSlot(billMonth, purchaseMonthForLine(ln))
  );
}

export type DropInvalidRealEstateLinksResult = {
  removedOutsideWindow: number;
  removedOrphan: number;
};

/** Remove links whose purchase month is outside bill+0/+1/+2 (no rejection row). */
export function dropInvalidRealEstateExpenseLinks(
  expectations: readonly ExpenseExpectationRow[],
  gastosLines: readonly FlowCcExpenseLineRow[],
  existingLinks: ReadonlyMap<number, RealEstateLinkRow>
): DropInvalidRealEstateLinksResult {
  const expById = new Map(expectations.map((e) => [e.id, e]));
  const del = db.prepare(`DELETE FROM real_estate_expense_links WHERE expense_entry_id = ?`);
  let removedOutsideWindow = 0;
  let removedOrphan = 0;

  const tx = db.transaction(() => {
    for (const [entryId, link] of existingLinks) {
      const exp = expById.get(entryId);
      if (!exp) {
        del.run(entryId);
        removedOrphan++;
        continue;
      }
      const line = gastosLineByPurchaseKey(link.purchase_key, gastosLines);
      if (!line) {
        del.run(entryId);
        removedOrphan++;
        continue;
      }
      const billMonth = billMonthFromSpentOn(exp.spent_on);
      if (!purchaseMonthMatchesBillSlot(billMonth, purchaseMonthForLine(line))) {
        del.run(entryId);
        removedOutsideWindow++;
      }
    }
  });
  tx();
  return { removedOutsideWindow, removedOrphan };
}

export type ReconcileRealEstateLinksResult = DropInvalidRealEstateLinksResult & {
  clearedAutoLinks: number;
  autoLinked: number;
};

/** Drop stale links, optionally clear auto links, then auto-link unlinked slots. */
export function reconcileRealEstateExpenseLinks(opts?: {
  resetAutoLinks?: boolean;
}): ReconcileRealEstateLinksResult {
  let clearedAutoLinks = 0;
  if (opts?.resetAutoLinks) {
    const r = db.prepare(`DELETE FROM real_estate_expense_links WHERE link_source = 'auto'`).run();
    clearedAutoLinks = r.changes;
  }

  const expectations = listRealEstateExpectations();
  const gastosLines = loadGastosLinesForRealEstateMatching();
  const dropped = dropInvalidRealEstateExpenseLinks(
    expectations,
    gastosLines,
    loadExistingLinks()
  );
  const newLinks = runAutoLinkPass(expectations, gastosLines, loadExistingLinks());
  persistAutoLinks(newLinks);
  return { ...dropped, clearedAutoLinks, autoLinked: newLinks.length };
}

export function runAutoLinkPass(
  expectations: readonly ExpenseExpectationRow[],
  gastosLines: readonly FlowCcExpenseLineRow[],
  existingLinks: ReadonlyMap<number, RealEstateLinkRow>
): RealEstateLinkRow[] {
  const linkedKeys = new Set([...existingLinks.values()].map((l) => l.purchase_key));
  const allRejections = loadAllRejections();
  const newLinks: RealEstateLinkRow[] = [];

  for (const exp of expectations) {
    if (exp.amount_clp <= 0) continue;
    if (existingLinks.has(exp.id)) continue;

    const billMonth = billMonthFromSpentOn(exp.spent_on);
    const rejections = allRejections.get(exp.id) ?? new Set<string>();
    const candidates = findAmountMatchCandidates(exp, gastosLines, linkedKeys, rejections);
    const picked = pickAutoLinkCandidate(exp, candidates, billMonth);
    if (!picked) continue;

    const link: RealEstateLinkRow = {
      expense_entry_id: exp.id,
      purchase_key: picked.purchase_key,
      link_source: "auto",
    };
    newLinks.push(link);
    linkedKeys.add(picked.purchase_key);
  }

  return newLinks;
}

export function persistAutoLinks(links: readonly RealEstateLinkRow[]): void {
  if (links.length === 0) return;
  const ins = db.prepare(
    `INSERT INTO real_estate_expense_links (expense_entry_id, purchase_key, link_source)
     VALUES (?, ?, ?)`
  );
  const tx = db.transaction(() => {
    for (const l of links) {
      ins.run(l.expense_entry_id, l.purchase_key, l.link_source);
    }
  });
  tx();
}

export function manualLinkRealEstateExpense(
  expenseEntryId: number,
  purchaseKey: string
): RealEstateLinkRow {
  const exp = loadExpectationById(expenseEntryId);
  if (!exp) throw new Error("expense entry not found");
  if (exp.amount_clp <= 0) throw new Error("kwh readings cannot be linked by amount");

  const gastosLines = loadGastosLinesForRealEstateMatching();
  const line = gastosLines.find((ln) => ln.purchase_key === purchaseKey);
  if (!line) throw new Error("purchase not found or not eligible");
  if (line.amount_clp !== exp.amount_clp) throw new Error("amount does not match expectation");

  const billMonth = billMonthFromSpentOn(exp.spent_on);
  const purchaseMonth = purchaseMonthForLine(line);
  if (!purchaseMonthMatchesBillSlot(billMonth, purchaseMonth)) {
    throw new Error("purchase month does not match bill slot window");
  }

  const linkedKeys = loadLinkedPurchaseKeys();
  if (linkedKeys.has(purchaseKey)) throw new Error("purchase already linked");

  const existing = db
    .prepare(`SELECT 1 FROM real_estate_expense_links WHERE expense_entry_id = ?`)
    .get(expenseEntryId);
  if (existing) throw new Error("expectation already linked");

  db.prepare(
    `INSERT INTO real_estate_expense_links (expense_entry_id, purchase_key, link_source)
     VALUES (?, ?, 'manual')`
  ).run(expenseEntryId, purchaseKey);

  return { expense_entry_id: expenseEntryId, purchase_key: purchaseKey, link_source: "manual" };
}

export function unmatchRealEstateExpense(expenseEntryId: number): void {
  const row = db
    .prepare(
      `SELECT purchase_key FROM real_estate_expense_links WHERE expense_entry_id = ?`
    )
    .get(expenseEntryId) as { purchase_key: string } | undefined;
  if (!row) throw new Error("link not found");

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM real_estate_expense_links WHERE expense_entry_id = ?`).run(
      expenseEntryId
    );
    db.prepare(
      `INSERT OR IGNORE INTO real_estate_expense_link_rejections (expense_entry_id, purchase_key)
       VALUES (?, ?)`
    ).run(expenseEntryId, row.purchase_key);
  });
  tx();
}

export function loadExpectationById(expenseEntryId: number): ExpenseExpectationRow | null {
  const row = db
    .prepare(
      `SELECT e.id, e.amount_clp, e.spent_on, e.category, e.note, e.expense_account_id, a.slug AS account_slug
       FROM expense_entries e
       JOIN expense_accounts a ON a.id = e.expense_account_id
       JOIN expense_groups g ON g.id = a.group_id
       WHERE e.id = ? AND g.slug = 'real_estate'`
    )
    .get(expenseEntryId) as
    | (Omit<ExpenseExpectationRow, "account_slug"> & { account_slug: string })
    | undefined;
  if (!row) return null;
  return {
    ...row,
    amount_clp: Math.round(row.amount_clp),
    account_slug: row.account_slug as RealEstateApartmentSlug,
  };
}

export function listRealEstateExpectations(): ExpenseExpectationRow[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.amount_clp, e.spent_on, e.category, e.note, e.expense_account_id, a.slug AS account_slug
       FROM expense_entries e
       JOIN expense_accounts a ON a.id = e.expense_account_id
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate' AND e.expense_account_id IS NOT NULL
       ORDER BY e.spent_on DESC, e.id DESC`
    )
    .all() as (Omit<ExpenseExpectationRow, "account_slug"> & { account_slug: string })[];

  return rows.map((r) => ({
    ...r,
    amount_clp: Math.round(r.amount_clp),
    account_slug: r.account_slug as RealEstateApartmentSlug,
  }));
}

export function gastosLineByPurchaseKey(
  purchaseKey: string,
  gastosLines: readonly FlowCcExpenseLineRow[]
): FlowCcExpenseLineRow | undefined {
  return gastosLines.find((ln) => ln.purchase_key === purchaseKey);
}

export function displayAmountClp(
  expectedAmount: number,
  linkedLine: FlowCcExpenseLineRow | undefined
): number {
  if (linkedLine && linkedLine.amount_clp > 0) return linkedLine.amount_clp;
  if (expectedAmount > 0) return expectedAmount;
  return 0;
}
