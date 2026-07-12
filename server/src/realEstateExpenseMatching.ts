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
  REAL_ESTATE_LINKABLE_KINDS,
} from "./realEstateExpenseMerchants.js";
import { monthEndUtcYmd } from "./calendarMonth.js";

/**
 * Bills pair with FULL payments: an installment-paid bill (TGR contribuciones in 3/6
 * cuotas) links to the plan's purchase-total line — one candidate per plan at the plan
 * amount — never to individual cuota lines (which share one purchase_key and would
 * create a one-cuota-sized bill).
 */
const GASTOS_INSTALLMENT_MODE = "total" as const;

/** Bill month X may be paid same month (X+0) or on the card in X+1 / X+2. */
export const REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MIN = 0;
export const REAL_ESTATE_LINK_PURCHASE_MONTH_OFFSET_MAX = 2;

export type ExpenseExpectationRow = {
  id: number;
  amount_clp: number;
  spent_on: string;
  category: string | null;
  note: string | null;
  kwh: number | null;
  m3: number | null;
  expense_account_id: number;
  account_slug: string;
  comunidad_patterns: string | null;
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
      expectation.comunidad_patterns,
      expectation.category ?? "",
      a.merchant_key
    );
    const bMerchant = merchantMatchesExpectation(
      expectation.comunidad_patterns,
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
      expectation.comunidad_patterns,
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

/** kWh is an electricity metric, m³ a gas metric — a bill only carries its own kind's reading. */
export function assertConsumptionMatchesKind(
  kind: string | null,
  values: { kwh: number | null | undefined; m3: number | null | undefined }
): void {
  if (kind === "gas" && values.kwh != null) {
    throw new Error("kwh belongs to electricidad bills, not gas");
  }
  if ((kind === "electricidad" || kind === "kwh") && values.m3 != null) {
    throw new Error("m3 belongs to gas bills, not electricidad");
  }
}

/** Set the consumption metadata (kWh / m³) on a real-estate bill entry. */
export function updateRealEstateExpenseConsumption(
  expenseEntryId: number,
  values: { kwh: number | null; m3: number | null }
): void {
  const exp = loadExpectationById(expenseEntryId);
  if (!exp) throw new Error("expense entry not found");
  for (const v of [values.kwh, values.m3]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      throw new Error("kwh/m3 must be non-negative numbers");
    }
  }
  assertConsumptionMatchesKind(exp.category, values);
  db.prepare(`UPDATE expense_entries SET kwh = ?, m3 = ? WHERE id = ?`).run(
    values.kwh,
    values.m3,
    expenseEntryId
  );
}

/**
 * Re-month a bill: set the billed-period month (stored as month-end `spent_on`).
 * When the entry has a linked purchase, the new month must keep the purchase
 * inside the bill+0..+2 window — otherwise the next auto-link pass would drop
 * the link, so reject instead.
 */
export function updateRealEstateExpenseBillMonth(
  expenseEntryId: number,
  billMonth: string
): void {
  const exp = loadExpectationById(expenseEntryId);
  if (!exp) throw new Error("expense entry not found");
  if (!/^\d{4}-\d{2}$/.test(billMonth)) throw new Error("bill_month must be YYYY-MM");

  const link = db
    .prepare(`SELECT purchase_key FROM real_estate_expense_links WHERE expense_entry_id = ?`)
    .get(expenseEntryId) as { purchase_key: string } | undefined;
  if (link) {
    const line = gastosLineByPurchaseKey(link.purchase_key, loadGastosLinesForRealEstateMatching());
    if (line && !purchaseMonthMatchesBillSlot(billMonth, purchaseMonthForLine(line))) {
      throw new Error(
        `bill_month ${billMonth} puts the linked purchase (${purchaseMonthForLine(line)}) outside the +0..+2 window`
      );
    }
  }

  db.prepare(`UPDATE expense_entries SET spent_on = ? WHERE id = ?`).run(
    monthEndUtcYmd(billMonth),
    expenseEntryId
  );
}

export type AssignPurchaseToRealEstateOpts = {
  purchaseKey: string;
  accountSlug: string;
  kind: string;
  /** Bill month YYYY-MM; defaults to the purchase month (offset 0). */
  billMonth?: string;
  kwh?: number | null;
  m3?: number | null;
};

/**
 * Purchase-first linking: create the bill expectation FROM an unlinked purchase (amount
 * and default month taken from the purchase) plus the manual link, in one transaction.
 * This is how history with no imported bills (el vergel, rents) gets covered — no
 * amounts are invented, the purchase itself is the record.
 */
export function assignPurchaseToRealEstateExpense(
  opts: AssignPurchaseToRealEstateOpts
): { expense_entry_id: number; link: RealEstateLinkRow } {
  if (!REAL_ESTATE_LINKABLE_KINDS.includes(opts.kind as (typeof REAL_ESTATE_LINKABLE_KINDS)[number])) {
    throw new Error(`kind must be one of: ${REAL_ESTATE_LINKABLE_KINDS.join(", ")}`);
  }
  const account = db
    .prepare(
      `SELECT a.id FROM expense_accounts a JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate' AND a.slug = ?`
    )
    .get(opts.accountSlug) as { id: number } | undefined;
  if (!account) throw new Error(`unknown real-estate expense account: ${opts.accountSlug}`);

  const gastosLines = loadGastosLinesForRealEstateMatching();
  const line = gastosLines.find((ln) => ln.purchase_key === opts.purchaseKey);
  if (!line) throw new Error("purchase not found or not eligible");
  if (loadLinkedPurchaseKeys().has(opts.purchaseKey)) throw new Error("purchase already linked");

  const purchaseMonth = purchaseMonthForLine(line);
  const billMonth = opts.billMonth ?? purchaseMonth;
  if (!/^\d{4}-\d{2}$/.test(billMonth)) throw new Error("bill_month must be YYYY-MM");
  if (!purchaseMonthMatchesBillSlot(billMonth, purchaseMonth)) {
    throw new Error("purchase month does not match bill slot window");
  }
  for (const v of [opts.kwh, opts.m3]) {
    if (v != null && (!Number.isFinite(v) || v < 0)) {
      throw new Error("kwh/m3 must be non-negative numbers");
    }
  }
  assertConsumptionMatchesKind(opts.kind, { kwh: opts.kwh, m3: opts.m3 });

  const noteParts = [line.merchant ?? opts.purchaseKey, line.purchase_on ?? purchaseMonth];
  const note = `Asignado desde compra — ${noteParts.join(" · ")}`;

  let entryId = 0;
  const tx = db.transaction(() => {
    const r = db
      .prepare(
        `INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id, kwh, m3)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        line.amount_clp,
        monthEndUtcYmd(billMonth),
        opts.kind,
        note,
        account.id,
        opts.kwh ?? null,
        opts.m3 ?? null
      );
    entryId = Number(r.lastInsertRowid);
    db.prepare(
      `INSERT INTO real_estate_expense_links (expense_entry_id, purchase_key, link_source)
       VALUES (?, ?, 'manual')`
    ).run(entryId, opts.purchaseKey);
  });
  tx();

  return {
    expense_entry_id: entryId,
    link: { expense_entry_id: entryId, purchase_key: opts.purchaseKey, link_source: "manual" },
  };
}

/** Delete a bill entry outright (link + rejections cascade). For rows created by assign. */
export function deleteRealEstateExpenseEntry(expenseEntryId: number): void {
  const exp = loadExpectationById(expenseEntryId);
  if (!exp) throw new Error("expense entry not found");
  db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(expenseEntryId);
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
      `SELECT e.id, e.amount_clp, e.spent_on, e.category, e.note, e.kwh, e.m3, e.expense_account_id, a.slug AS account_slug, a.comunidad_merchant_patterns AS comunidad_patterns
       FROM expense_entries e
       JOIN expense_accounts a ON a.id = e.expense_account_id
       JOIN expense_groups g ON g.id = a.group_id
       WHERE e.id = ? AND g.slug = 'real_estate'`
    )
    .get(expenseEntryId) as ExpenseExpectationRow | undefined;
  if (!row) return null;
  return { ...row, amount_clp: Math.round(row.amount_clp) };
}

export function listRealEstateExpectations(): ExpenseExpectationRow[] {
  const rows = db
    .prepare(
      `SELECT e.id, e.amount_clp, e.spent_on, e.category, e.note, e.kwh, e.m3, e.expense_account_id, a.slug AS account_slug, a.comunidad_merchant_patterns AS comunidad_patterns
       FROM expense_entries e
       JOIN expense_accounts a ON a.id = e.expense_account_id
       JOIN expense_groups g ON g.id = a.group_id
       WHERE g.slug = 'real_estate' AND e.expense_account_id IS NOT NULL
       ORDER BY e.spent_on DESC, e.id DESC`
    )
    .all() as ExpenseExpectationRow[];

  return rows.map((r) => ({ ...r, amount_clp: Math.round(r.amount_clp) }));
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
