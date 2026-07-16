/** Flows: deposits, income, work earnings, expenses (manual, CC, real estate). Split verbatim from index.ts; paths unchanged. */
import express from "express";
import { db } from "../db.js";
import { buildDepositsReconciliationPayload } from "../flowsDepositsReconciliation.js";
import { buildFlowsDepositsPayload } from "../flowsDeposits.js";
import { buildFlowsPlPayload } from "../flowsPl.js";
import { assignCcExpenseCategoryForManualLedgerInstallmentPurchase } from "../ccExpenseCategories.js";
import { purchaseIdFromPlanGastosLineId } from "../ccInstallmentPlanGastosLines.js";
import { assignFlowExpenseLineCategory } from "../assignFlowExpenseLineCategory.js";
import { resolveCcExpensePurchaseKey } from "../ccExpenseCategories.js";
import { setCcExpensePurchaseNote } from "../ccExpensePurchaseNotes.js";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
} from "../ccExpenseBigGroups.js";
import { buildFlowsCreditCardExpensesPayload } from "../flowsCreditCardExpenses.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  upsertCcFacturadoFinancingLink,
} from "../ccFacturadoFinancingLinksDb.js";
import { buildFlowsCheckingIncomePayload } from "../flowsCheckingInflows.js";
import {
  type CheckingIncomeKind,
  clearCheckingIncomeForceInclude,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "../flowsCheckingIncomeOverrides.js";
import { updatePayrollWorkEarning, type PayrollEarningType } from "../flowsPayrollWorkEarnings.js";
import {
  assertMovementEligibleForPayrollLink,
  listPayrollLinkCandidates,
} from "../payrollWorkEarningsLinking.js";
import { normalizeManualExpenseNote, validateManualExpenseCategorySlug } from "../flowsManualExpenses.js";
import {
  buildRealEstateExpensesPayload,
  createRealEstatePlace,
  listRealEstateLinkCandidates,
  listRealEstateUnlinkedPurchases,
} from "../flowsRealEstateExpenses.js";
import {
  assignPurchaseToRealEstateExpense,
  deleteRealEstateExpenseEntry,
  manualLinkRealEstateExpense,
  unmatchRealEstateExpense,
  updateRealEstateExpenseBillMonth,
  updateRealEstateExpenseConsumption,
} from "../realEstateExpenseMatching.js";
import {
  isFiniteNumber,
  isPositiveFiniteNumber,
  isYmdString,
} from "../requestValidation.js";
import { parseProxyTickersParam } from "./shared.js";

export function registerFlowsRoutes(app: express.Express): void {
app.get("/api/flows/deposits", (_req, res) => {
  res.json(buildFlowsDepositsPayload());
});

app.get("/api/flows/pl", (_req, res) => {
  res.json(buildFlowsPlPayload());
});

app.get("/api/flows/deposits/reconciliation", (_req, res) => {
  try {
    res.json(buildDepositsReconciliationPayload());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/income", (_req, res) => {
  res.json(buildFlowsCheckingIncomePayload());
});

app.post("/api/income", (req, res) => {
  const { amount_clp, received_on, source, note } = req.body as {
    amount_clp?: unknown;
    received_on?: unknown;
    source?: string;
    note?: string;
  };
  if (!isFiniteNumber(amount_clp)) {
    res.status(400).json({ error: "amount_clp must be a finite number" });
    return;
  }
  if (!isYmdString(received_on)) {
    res.status(400).json({ error: "received_on must be YYYY-MM-DD" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO income_entries (amount_clp, received_on, source, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, received_on, source ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.patch("/api/work-earnings/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid id" });
    return;
  }
  const body = req.body as {
    earning_type?: PayrollEarningType;
    movement_id?: number | null;
  };
  if (body.earning_type != null && body.earning_type !== "salary" && body.earning_type !== "severance") {
    res.status(400).json({ error: "earning_type must be salary or severance" });
    return;
  }
  if (body.movement_id !== undefined && body.movement_id != null) {
    if (!Number.isFinite(body.movement_id) || body.movement_id <= 0) {
      res.status(400).json({ error: "invalid movement_id" });
      return;
    }
    try {
      assertMovementEligibleForPayrollLink(
        body.movement_id,
        listPayrollLinkCandidates()
      );
    } catch (e) {
      res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
      return;
    }
  }
  try {
    const row = updatePayrollWorkEarning(id, {
      earning_type: body.earning_type,
      movement_id: body.movement_id,
    });
    res.json(row);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.patch("/api/income/movements/:movement_id", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  const body = req.body as {
    income_kind?: CheckingIncomeKind;
    excluded?: boolean;
    force_include?: boolean;
    note?: string | null;
  };
  if (
    body.income_kind != null &&
    body.income_kind !== "salary" &&
    body.income_kind !== "severance" &&
    body.income_kind !== "other" &&
    body.income_kind !== "parent_gift"
  ) {
    res.status(400).json({
      error: "income_kind must be salary, severance, other, or parent_gift",
    });
    return;
  }
  if (
    body.income_kind === undefined &&
    body.excluded === undefined &&
    body.force_include === undefined &&
    body.note === undefined
  ) {
    res.status(400).json({ error: "income_kind, excluded, force_include, or note required" });
    return;
  }
  try {
    if (body.excluded === false) {
      restoreCheckingIncomeMovement(movementId);
      res.json({
        movement_id: movementId,
        excluded: false,
        force_include: false,
        income_kind: null,
        note: null,
      });
      return;
    }
    if (body.force_include === false) {
      clearCheckingIncomeForceInclude(movementId);
      res.json({
        movement_id: movementId,
        excluded: false,
        force_include: false,
        income_kind: null,
        note: null,
      });
      return;
    }
    const row = upsertCheckingIncomeMovementOverride(movementId, {
      income_kind: body.income_kind,
      excluded: body.excluded,
      force_include: body.force_include,
      note: body.note,
    });
    res.json({
      movement_id: row.movement_id,
      excluded: row.is_excluded === 1,
      force_include: row.force_include === 1,
      income_kind: row.income_kind,
      note: row.note,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/income/movements/:movement_id/force-include", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  try {
    const row = upsertCheckingIncomeMovementOverride(movementId, { force_include: true });
    res.json({
      ok: true,
      movement_id: row.movement_id,
      force_include: true,
    });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.post("/api/income/movements/:movement_id/restore", (req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  try {
    restoreCheckingIncomeMovement(movementId);
    res.json({ ok: true, movement_id: movementId });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : String(e) });
  }
});

app.get("/api/expenses", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note, import_batch_id, expense_account_id
       FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.get("/api/flows/expenses/credit-card", (req, res) => {
  const proxyTickers = parseProxyTickersParam(req.query.proxy_tickers);
  res.json(buildFlowsCreditCardExpensesPayload(proxyTickers ?? undefined));
});

app.get("/api/flows/expenses/credit-card/financing-links", (_req, res) => {
  res.json({ links: listCcFacturadoFinancingLinks() });
});

app.post("/api/flows/expenses/credit-card/financing-links", (req, res) => {
  const body = req.body as {
    financed_account_id?: number;
    financed_billing_month?: string;
    financing?: { account_id?: number; purchase_key?: string }[];
  };
  const financedAccountId = Number(body.financed_account_id);
  const financedBillingMonth = String(body.financed_billing_month ?? "").trim();
  const financing = (body.financing ?? [])
    .map((f) => ({ account_id: Number(f.account_id), purchase_key: String(f.purchase_key ?? "").trim() }))
    .filter((f) => Number.isFinite(f.account_id) && f.account_id > 0 && f.purchase_key.length > 0);
  if (!Number.isFinite(financedAccountId) || financedAccountId <= 0 || !financedBillingMonth) {
    res.status(400).json({ error: "financed_account_id and financed_billing_month required" });
    return;
  }
  try {
    const link = upsertCcFacturadoFinancingLink({
      financedAccountId,
      financedBillingMonth,
      financing,
    });
    res.json({ ok: true, id: link.id });
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "link failed" });
  }
});

app.delete("/api/flows/expenses/credit-card/financing-links/:id", (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid link id" });
    return;
  }
  deleteCcFacturadoFinancingLink(id);
  res.status(204).send();
});

app.get("/api/flows/expenses/real-estate", (_req, res) => {
  res.json(buildRealEstateExpensesPayload());
});

app.get("/api/flows/expenses/real-estate/candidates", (req, res) => {
  const expenseEntryId = Number(req.query.expense_entry_id);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "expense_entry_id required" });
    return;
  }
  res.json({ candidates: listRealEstateLinkCandidates(expenseEntryId) });
});

app.put("/api/flows/expenses/real-estate/links", (req, res) => {
  const body = req.body as { expense_entry_id?: number; purchase_key?: string };
  const expenseEntryId = Number(body.expense_entry_id);
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0 || !purchaseKey) {
    res.status(400).json({ error: "expense_entry_id and purchase_key required" });
    return;
  }
  try {
    const link = manualLinkRealEstateExpense(expenseEntryId, purchaseKey);
    res.json(link);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "link failed";
    res.status(400).json({ error: msg });
  }
});

app.delete("/api/flows/expenses/real-estate/links/:expenseEntryId", (req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  try {
    unmatchRealEstateExpense(expenseEntryId);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unmatch failed";
    res.status(400).json({ error: msg });
  }
});

app.get("/api/flows/expenses/real-estate/unlinked-purchases", (req, res) => {
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  res.json({
    purchases: listRealEstateUnlinkedPurchases({
      q: str(req.query.q),
      month: str(req.query.month),
      category: str(req.query.category),
      placeSlug: str(req.query.place),
      kind: str(req.query.kind),
      limit: req.query.limit != null ? Number(req.query.limit) : undefined,
    }),
  });
});

app.post("/api/flows/expenses/real-estate/places", (req, res) => {
  const body = req.body as {
    slug?: string;
    label?: string;
    active_from?: string | null;
    active_to?: string | null;
    property_account_id?: number | null;
  };
  try {
    const place = createRealEstatePlace({
      slug: String(body.slug ?? ""),
      label: String(body.label ?? ""),
      activeFrom: body.active_from ?? null,
      activeTo: body.active_to ?? null,
      propertyAccountId: body.property_account_id ?? null,
    });
    res.status(201).json(place);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create place failed";
    res.status(400).json({ error: msg });
  }
});

/** Net-worth property masters (candidates for a place's property_account_id link). */
app.get("/api/flows/expenses/real-estate/property-accounts", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.name FROM accounts a
       JOIN portfolio_group_items i ON i.account_id = a.id
       JOIN portfolio_groups g ON g.id = i.portfolio_group_id
       WHERE g.slug = 'real_estate' AND a.account_kind = 'master'
       ORDER BY a.name`
    )
    .all();
  res.json({ accounts: rows });
});

app.post("/api/flows/expenses/real-estate/assign", (req, res) => {
  const body = req.body as {
    purchase_key?: string;
    account_slug?: string;
    kind?: string;
    bill_month?: string;
    kwh?: number | null;
    m3?: number | null;
  };
  const purchaseKey = String(body.purchase_key ?? "").trim();
  const accountSlug = String(body.account_slug ?? "").trim();
  const kind = String(body.kind ?? "").trim();
  if (!purchaseKey || !accountSlug || !kind) {
    res.status(400).json({ error: "purchase_key, account_slug and kind required" });
    return;
  }
  try {
    const result = assignPurchaseToRealEstateExpense({
      purchaseKey,
      accountSlug,
      kind,
      billMonth: typeof body.bill_month === "string" ? body.bill_month : undefined,
      kwh: body.kwh ?? null,
      m3: body.m3 ?? null,
    });
    res.status(201).json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "assign failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/bill-month", (req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  const billMonth = String((req.body as { bill_month?: string }).bill_month ?? "").trim();
  if (!/^\d{4}-\d{2}$/.test(billMonth)) {
    res.status(400).json({ error: "bill_month must be YYYY-MM" });
    return;
  }
  try {
    updateRealEstateExpenseBillMonth(expenseEntryId, billMonth);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "update failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/consumption", (req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  const body = req.body as { kwh?: number | null; m3?: number | null };
  try {
    updateRealEstateExpenseConsumption(expenseEntryId, {
      kwh: body.kwh ?? null,
      m3: body.m3 ?? null,
    });
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "update failed";
    res.status(400).json({ error: msg });
  }
});

app.delete("/api/flows/expenses/real-estate/entries/:expenseEntryId", (req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  try {
    deleteRealEstateExpenseEntry(expenseEntryId);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "delete failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/purchase-notes", (req, res) => {
  const body = req.body as {
    account_id?: number;
    purchase_key?: string;
    statement_line_id?: number;
    notes?: string | null;
  };
  const accountId = Number(body.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account_id" });
    return;
  }
  let purchaseKey = String(body.purchase_key ?? "").trim();
  const statementLineId = Number(body.statement_line_id);
  if (!purchaseKey && Number.isFinite(statementLineId) && statementLineId > 0) {
    purchaseKey = resolveCcExpensePurchaseKey(statementLineId);
  }
  if (!purchaseKey) {
    res.status(400).json({ error: "purchase_key or statement_line_id required" });
    return;
  }
  try {
    const result = setCcExpensePurchaseNote({
      accountId,
      purchaseKey,
      notes: body.notes,
    });
    res.json({ account_id: accountId, purchase_key: purchaseKey, notes: result.notes });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    console.error("PATCH /api/flows/expenses/credit-card/purchase-notes", {
      body: req.body,
      error: msg,
      stack: e instanceof Error ? e.stack : undefined,
    });
    res.status(400).json({ error: msg });
  }
});

app.put("/api/flows/expenses/credit-card/purchase-big-group", (req, res) => {
  const body = req.body as {
    account_id?: number;
    purchase_key?: string;
    group_slug?: string | null;
  };
  const accountId = Number(body.account_id);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    res.status(400).json({ error: "invalid account_id" });
    return;
  }
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!purchaseKey) {
    res.status(400).json({ error: "purchase_key required" });
    return;
  }
  try {
    const result = setCcExpensePurchaseBigGroup({
      accountId,
      purchaseKey,
      groupSlug: body.group_slug,
    });
    res.json({
      account_id: accountId,
      purchase_key: purchaseKey,
      group_slug: result.group_slug,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "save failed";
    res.status(400).json({ error: msg });
  }
});

app.post("/api/flows/expenses/credit-card/big-groups", (req, res) => {
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!label) {
    res.status(400).json({ error: "label required" });
    return;
  }
  try {
    const group = createCcExpenseBigGroup(label);
    res.status(201).json(group);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "create failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/big-groups/:slug", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!slug || !label) {
    res.status(400).json({ error: "slug and label required" });
    return;
  }
  try {
    const group = renameCcExpenseBigGroup(slug, label);
    res.json(group);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "rename failed";
    res.status(400).json({ error: msg });
  }
});

app.delete("/api/flows/expenses/credit-card/big-groups/:slug", (req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  try {
    deleteCcExpenseBigGroup(slug);
    res.status(204).send();
  } catch (e) {
    const msg = e instanceof Error ? e.message : "delete failed";
    res.status(400).json({ error: msg });
  }
});

app.patch("/api/flows/expenses/credit-card/lines/:lineId/category", (req, res) => {
  const route = "PATCH /api/flows/expenses/credit-card/lines/:lineId/category";
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId === 0) {
    console.error(route, { lineId: req.params.lineId, reason: "line id must be non-zero finite" });
    res.status(400).json({ error: "invalid line id" });
    return;
  }
  const body = req.body as {
    category_slug?: string;
    unique?: boolean;
    clear_category?: boolean;
    source?: "cc" | "checking" | "manual";
  };
  const categorySlug = body.category_slug != null ? String(body.category_slug).trim() : "";
  const unique = !!body.unique;
  const clearCategory = body.clear_category === true;
  try {
    if (body.source === "manual") {
      res.status(400).json({ error: "manual expense entries are not editable" });
      return;
    }
    if (lineId < 0) {
      // Plan gastos lines encode purchaseId as -(3_000_000_000 + purchaseId*1000 + cuotaIndex).
      // Simple negative statement line ids encode purchaseId as -lineId directly.
      const purchaseId = purchaseIdFromPlanGastosLineId(lineId) ?? -lineId;
      const result = assignCcExpenseCategoryForManualLedgerInstallmentPurchase({
        purchaseId,
        unique,
        categorySlug: categorySlug || null,
        clearCategory,
      });
      res.json(result);
      return;
    }
    const bodySource = body.source;
    const source =
      bodySource === "checking" || bodySource === "cc" || bodySource === "manual"
        ? bodySource
        : undefined;
    const result = assignFlowExpenseLineCategory({
      lineId,
      source,
      unique,
      categorySlug: categorySlug || null,
      clearCategory,
    });
    res.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "assign failed";
    console.error(route, {
      lineId,
      body: req.body,
      error: msg,
      stack: e instanceof Error ? e.stack : undefined,
    });
    res.status(400).json({ error: msg });
  }
});

app.post("/api/expenses", (req, res) => {
  const { amount_clp, spent_on, category, note } = req.body as {
    amount_clp?: unknown;
    spent_on?: unknown;
    category?: string;
    note?: string;
  };
  if (!isPositiveFiniteNumber(amount_clp)) {
    res.status(400).json({ error: "positive amount_clp required" });
    return;
  }
  if (!isYmdString(spent_on)) {
    res.status(400).json({ error: "spent_on must be YYYY-MM-DD" });
    return;
  }
  try {
    const categorySlug = validateManualExpenseCategorySlug(category);
    const normalizedNote = normalizeManualExpenseNote(note);
    const r = db
      .prepare(
        `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
      )
      .run(amount_clp, spent_on, categorySlug, normalizedNote);
    res.status(201).json({ id: Number(r.lastInsertRowid) });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "invalid expense";
    res.status(400).json({ error: msg });
  }
});

/** Stale external sources + last sync state (AFP / Fintual / BCentral BDE). */
}
