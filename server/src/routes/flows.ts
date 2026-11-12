/** Flows: deposits, income, work earnings, expenses (manual, CC, real estate). Split verbatim from index.ts; paths unchanged. */
import { syncCardToCardPaymentTransfers } from "../cardToCardPayments.js";
import { assertDemoManualExpenseDescription } from "../demoWritePolicy.js";
import express from "express";
import { writeHandler } from "../inputError.js";
import { requestExpenseLinkSync, withExpenseLinkSyncDeferred } from "../expenseLinkSync.js";
import { buildPayrollBreakdown } from "../payrollBreakdown.js";
import { buildPayslipChecks } from "../payslipChecks.js";
import { db } from "../db.js";
import { saveVendorBranchChoice } from "../vendorCatalog.js";
import type { CategoryRuleLinkKind } from "../expenseCategoryRules.js";
import { buildDepositsReconciliationPayload } from "../flowsDepositsReconciliation.js";
import { buildFlowsDepositsPayload } from "../flowsDeposits.js";
import {
  cachedFlowsExpensesGastosPayload,
  cachedFlowsExpensesPayload,
  cachedMortgageCarryingEvents,
} from "../flowsMortgageCarrying.js";
import { buildFlowsPlPayload } from "../flowsPl.js";
import { buildFlowsIncomeAggregates, buildFlowsOverviewPayload } from "../flowsOverview.js";
import { DAILY_SERIES_MAX_DAYS } from "../dailySeries.js";
import { assignFlowExpenseLineCategory } from "../expenseAssignmentWrites.js";
import {
  getExpenseLinePieces,
  replaceExpenseLinePieces,
  type ExpenseLinePieceInput,
  type ExpenseLinePieceSource,
} from "../expenseLinePieces.js";
import {
  createManualExpense,
  deleteManualExpense,
  updateManualExpense,
  type ManualExpenseInput,
} from "../flowsManualExpenses.js";
import { resolveCcExpensePurchaseKey } from "../ccExpenseCategories.js";
import { setCcExpensePurchaseNote } from "../ccExpensePurchaseNotes.js";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
} from "../ccExpenseBigGroups.js";
import {
  deleteCcFacturadoFinancingLink,
  listCcFacturadoFinancingLinks,
  upsertCcFacturadoFinancingLink,
} from "../ccFacturadoFinancingLinksDb.js";
import { buildFlowsCheckingIncomePayload } from "../flowsCheckingInflows.js";
import { markCheckingExpenseRefund, unmarkCheckingExpenseRefund } from "../checkingExpenseRefunds.js";
import { transferCounterpartiesByMovementSide, withTransferCounterparties } from "../bankTransferNotices.js";
import {
  CHECKING_INCOME_KINDS,
  type CheckingIncomeKind,
  clearCheckingIncomeForceInclude,
  isCheckingIncomeKind,
  loadRentPlaceSlugByMovementId,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "../flowsCheckingIncomeOverrides.js";
import { updatePayrollWorkEarning, type PayrollEarningType } from "../flowsPayrollWorkEarnings.js";
import {
  assertMovementEligibleForPayrollLink,
  listPayrollLinkCandidates,
} from "../payrollWorkEarningsLinking.js";
import {
  buildRealEstateExpensesPayload,
  createRealEstatePlace,
  listRealEstateLinkCandidates,
  listRealEstatePlaces,
  listRealEstateUnlinkedPurchases,
  setRealEstatePlaceDfl2,
} from "../flowsRealEstateExpenses.js";
import type { IncomeRentPlacesResponse } from "nw-tracker-contracts/dto/flows";
import {
  assignPurchaseToRealEstateExpense,
  deleteRealEstateExpenseEntry,
  manualLinkRealEstateExpense,
  unmatchRealEstateExpense,
  updateRealEstateExpenseBillMonth,
  updateRealEstateExpenseMonthsCovered,
  updateRealEstateExpenseConsumption,
} from "../realEstateExpenseMatching.js";

/**
 * A write that can move an expense deposit link (an income mark, a refund, pieces, a manual
 * expense): the links re-sync once it is done — reading the lines never does.
 */
const linkSyncingWrite = (fn: (req: express.Request, res: express.Response) => void): express.RequestHandler =>
  writeHandler((req, res) =>
    withExpenseLinkSyncDeferred(() => {
      fn(req, res);
      requestExpenseLinkSync();
    })
  );

export function registerFlowsRoutes(app: express.Express): void {
app.get("/api/flows/deposits", (_req, res) => {
  res.json(
    buildFlowsDepositsPayload({
      excludeCheckingAccounts: true,
      withMortgageCarrying: { clp: cachedMortgageCarryingEvents("clp"), usd: cachedMortgageCarryingEvents("usd") },
    })
  );
});

app.get("/api/flows/pl", (req, res) => {
  // `days` (0 = total) opts into the Diario per-day P/L block; absent = M/Y-only (unchanged).
  const days = req.query.days != null ? Number(req.query.days) : null;
  if (days != null && (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS)) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(buildFlowsPlPayload(days != null ? { days } : undefined));
});

app.get("/api/flows/overview", (req, res) => {
  const unit = String(req.query.unit ?? "clp");
  if (unit !== "clp" && unit !== "usd") {
    res.status(400).json({ error: `unit must be clp or usd, got ${unit}` });
    return;
  }
  const mode = String(req.query.installment_mode ?? "split");
  if (mode !== "split" && mode !== "total") {
    res.status(400).json({ error: `installment_mode must be split or total, got ${mode}` });
    return;
  }
  // `days` (0 = total) opts into the Diario day rows; absent = month rows only.
  const days = req.query.days != null ? Number(req.query.days) : null;
  if (days != null && (!Number.isInteger(days) || days < 0 || days > DAILY_SERIES_MAX_DAYS)) {
    res.status(400).json({ error: `days must be 0..${DAILY_SERIES_MAX_DAYS}` });
    return;
  }
  res.json(buildFlowsOverviewPayload(unit, mode, days));
});

app.get("/api/flows/deposits/reconciliation", (_req, res) => {
  try {
    res.json(buildDepositsReconciliationPayload());
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

app.get("/api/income", (req, res) => {
  const unit = String(req.query.unit ?? "clp");
  if (unit !== "clp" && unit !== "usd") {
    res.status(400).json({ error: `unit must be clp or usd, got ${unit}` });
    return;
  }
  const payload = buildFlowsCheckingIncomePayload();
  const counterparties = transferCounterpartiesByMovementSide();
  res.json({
    ...payload,
    lines: withTransferCounterparties(payload.lines, counterparties),
    excluded_lines: withTransferCounterparties(payload.excluded_lines, counterparties),
    filtered_lines: withTransferCounterparties(payload.filtered_lines, counterparties),
    refund_lines: withTransferCounterparties(payload.refund_lines, counterparties),
    payroll_breakdown: buildPayrollBreakdown(),
    payslip_checks: buildPayslipChecks(),
    // The page's month rows, day points and total, from the overview's own income rule.
    aggregates: buildFlowsIncomeAggregates(payload, unit),
  });
});

app.patch("/api/work-earnings/:id", writeHandler((req, res) => {
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
  const row = updatePayrollWorkEarning(id, {
    earning_type: body.earning_type,
    movement_id: body.movement_id,
  });
  res.json(row);
}));

app.patch("/api/income/movements/:movement_id", linkSyncingWrite((req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  const body = req.body as {
    income_kind?: CheckingIncomeKind;
    rent_place_slug?: string;
    excluded?: boolean;
    force_include?: boolean;
    note?: string | null;
  };
  if (body.rent_place_slug !== undefined && typeof body.rent_place_slug !== "string") {
    res.status(400).json({ error: "rent_place_slug must be a place slug" });
    return;
  }
  if (body.income_kind != null && !isCheckingIncomeKind(body.income_kind)) {
    res.status(400).json({
      error: `income_kind must be one of ${CHECKING_INCOME_KINDS.join(", ")}`,
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
    rent_place_slug: body.rent_place_slug,
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
}));

/** The places a rent credit can name (the income page's type select) and the place each rent line names. */
app.get("/api/income/rent-places", (_req, res) => {
  const body: IncomeRentPlacesResponse = {
    places: listRealEstatePlaces().map((p) => ({ slug: p.slug, label: p.label, dfl2: p.dfl2 })),
    place_by_movement_id: loadRentPlaceSlugByMovementId(),
  };
  res.json(body);
});

app.post("/api/income/movements/:movement_id/force-include", linkSyncingWrite((req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  const row = upsertCheckingIncomeMovementOverride(movementId, { force_include: true });
  res.json({
    ok: true,
    movement_id: row.movement_id,
    force_include: true,
  });
}));

/** Marks a checking credit as a refund of spending (out of income, a negative gastos line). */
app.post("/api/income/movements/:movement_id/refund", linkSyncingWrite((req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  const slug = (req.body as { category_slug?: unknown } | undefined)?.category_slug;
  try {
    markCheckingExpenseRefund(movementId, typeof slug === "string" && slug.trim() ? slug.trim() : undefined);
    res.json({ ok: true, movement_id: movementId });
  } catch (e) {
    const err = e as Error & { status?: number };
    res.status(err.status ?? 400).json({ error: err.message });
  }
}));

app.delete("/api/income/movements/:movement_id/refund", linkSyncingWrite((req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  unmarkCheckingExpenseRefund(movementId);
  res.json({ ok: true, movement_id: movementId });
}));

app.post("/api/income/movements/:movement_id/restore", linkSyncingWrite((req, res) => {
  const movementId = Number(req.params.movement_id);
  if (!Number.isFinite(movementId) || movementId <= 0) {
    res.status(400).json({ error: "invalid movement_id" });
    return;
  }
  restoreCheckingIncomeMovement(movementId);
  res.json({ ok: true, movement_id: movementId });
}));

app.get("/api/expenses", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note, import_batch_id, expense_account_id
       FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.get("/api/flows/expenses/credit-card", (_req, res) => {
  res.json(cachedFlowsExpensesPayload());
});

app.get("/api/flows/expenses/credit-card/gastos", (req, res) => {
  const unitRaw = String(req.query.unit ?? "clp");
  if (unitRaw !== "clp" && unitRaw !== "usd") {
    res.status(400).json({ error: `unit must be clp or usd, got ${unitRaw}` });
    return;
  }
  const excluded = new Set(
    String(req.query.exclude_big_groups ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  const preTaxRaw = String(req.query.include_pre_tax ?? "0");
  if (preTaxRaw !== "0" && preTaxRaw !== "1") {
    res.status(400).json({ error: `include_pre_tax must be 0 or 1, got ${preTaxRaw}` });
    return;
  }
  res.json(cachedFlowsExpensesGastosPayload(unitRaw, excluded, preTaxRaw === "1"));
});

function piecesLineRef(source: unknown, lineId: unknown): { source: ExpenseLinePieceSource; lineId: number } {
  const src = String(source ?? "");
  if (src !== "cc" && src !== "checking") throw new Error(`source must be cc or checking, got ${src}`);
  const id = Number(lineId);
  if (!Number.isInteger(id) || id <= 0) throw new Error(`invalid line_id ${String(lineId)}`);
  return { source: src, lineId: id };
}

app.get("/api/flows/expenses/line-pieces", (req, res) => {
  const ref = piecesLineRef(req.query.source, req.query.line_id);
  res.json(getExpenseLinePieces(ref.source, ref.lineId));
});

app.put("/api/flows/expenses/line-pieces", linkSyncingWrite((req, res) => {
  const body = req.body as { source?: string; line_id?: number; pieces?: ExpenseLinePieceInput[] };
  const ref = piecesLineRef(body.source, body.line_id);
  if (!Array.isArray(body.pieces)) throw new Error("pieces must be an array");
  res.json(replaceExpenseLinePieces(ref.source, ref.lineId, body.pieces));
}));

app.post("/api/flows/expenses/manual", linkSyncingWrite((req, res) => {
  assertDemoManualExpenseDescription((req.body as ManualExpenseInput | undefined)?.description);
  res.status(201).json(createManualExpense(req.body as ManualExpenseInput));
}));

app.patch("/api/flows/expenses/manual/:id", linkSyncingWrite((req, res) => {
  assertDemoManualExpenseDescription((req.body as ManualExpenseInput | undefined)?.description);
  updateManualExpense(Number(req.params.id), req.body as ManualExpenseInput);
  res.json({ ok: true });
}));

app.delete("/api/flows/expenses/manual/:id", linkSyncingWrite((req, res) => {
  deleteManualExpense(Number(req.params.id));
  res.status(204).send();
}));

app.get("/api/flows/expenses/credit-card/financing-links", (_req, res) => {
  // The manager lists financing by cuotas: a facturado paid outright (charges only) is not one.
  res.json({
    links: listCcFacturadoFinancingLinks()
      .filter((l) => l.financing.length > 0)
      .map(({ id, financed_account_id, financed_billing_month, financing }) => ({
        id,
        financed_account_id,
        financed_billing_month,
        financing,
      })),
  });
});

app.post("/api/flows/expenses/credit-card/financing-links", writeHandler((req, res) => {
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
  const link = upsertCcFacturadoFinancingLink({
    financedAccountId,
    financedBillingMonth,
    financing,
  });
  syncCardToCardPaymentTransfers();
  res.json({ ok: true, id: link.id });
}));

app.delete("/api/flows/expenses/credit-card/financing-links/:id", writeHandler((req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: "invalid link id" });
    return;
  }
  deleteCcFacturadoFinancingLink(id);
  syncCardToCardPaymentTransfers();
  res.status(204).send();
}));

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

app.put("/api/flows/expenses/real-estate/links", writeHandler((req, res) => {
  const body = req.body as { expense_entry_id?: number; purchase_key?: string };
  const expenseEntryId = Number(body.expense_entry_id);
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0 || !purchaseKey) {
    res.status(400).json({ error: "expense_entry_id and purchase_key required" });
    return;
  }
  const link = manualLinkRealEstateExpense(expenseEntryId, purchaseKey);
  res.json(link);
}));

app.delete("/api/flows/expenses/real-estate/links/:expenseEntryId", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  unmatchRealEstateExpense(expenseEntryId);
  res.status(204).send();
}));

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

app.post("/api/flows/expenses/real-estate/places", writeHandler((req, res) => {
  const body = req.body as {
    slug?: string;
    label?: string;
    active_from?: string | null;
    active_to?: string | null;
    property_account_id?: number | null;
    dfl2?: boolean;
    dfl2_built_m2?: number | null;
    dfl2_reception_year?: number | null;
  };
  const place = createRealEstatePlace({
    slug: String(body.slug ?? ""),
    label: String(body.label ?? ""),
    activeFrom: body.active_from ?? null,
    activeTo: body.active_to ?? null,
    propertyAccountId: body.property_account_id ?? null,
    dfl2: {
      dfl2: body.dfl2 === true,
      builtM2: body.dfl2_built_m2 ?? null,
      receptionYear: body.dfl2_reception_year ?? null,
    },
  });
  res.status(201).json(place);
}));

/** A place's DFL-2 declaration: the flag with the built area and the reception year, or none. */
app.patch("/api/flows/expenses/real-estate/places/:slug/dfl2", writeHandler((req, res) => {
  const body = req.body as { dfl2?: unknown; dfl2_built_m2?: unknown; dfl2_reception_year?: unknown };
  if (typeof body.dfl2 !== "boolean") {
    res.status(400).json({ error: "dfl2 must be a boolean" });
    return;
  }
  const num = (v: unknown, name: string): number | null => {
    if (v == null) return null;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
    return v;
  };
  res.json(
    setRealEstatePlaceDfl2(String(req.params.slug), {
      dfl2: body.dfl2,
      builtM2: num(body.dfl2_built_m2, "dfl2_built_m2"),
      receptionYear: num(body.dfl2_reception_year, "dfl2_reception_year"),
    })
  );
}));

/** Net-worth property masters (candidates for a place's property_account_id link). */
app.get("/api/flows/expenses/real-estate/property-accounts", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT a.id, a.name FROM accounts a
       JOIN portfolio_group_items i ON i.account_id = a.id
       JOIN portfolio_groups g ON g.id = i.portfolio_group_id
       WHERE g.slug = 'real_estate'
       ORDER BY a.name`
    )
    .all();
  res.json({ accounts: rows });
});

app.post("/api/flows/expenses/real-estate/assign", writeHandler((req, res) => {
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
  const result = assignPurchaseToRealEstateExpense({
    purchaseKey,
    accountSlug,
    kind,
    billMonth: typeof body.bill_month === "string" ? body.bill_month : undefined,
    kwh: body.kwh ?? null,
    m3: body.m3 ?? null,
  });
  res.status(201).json(result);
}));

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/bill-month", writeHandler((req, res) => {
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
  updateRealEstateExpenseBillMonth(expenseEntryId, billMonth);
  res.status(204).send();
}));

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/months-covered", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  updateRealEstateExpenseMonthsCovered(expenseEntryId, Number((req.body as { months_covered?: number }).months_covered));
  res.status(204).send();
}));

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/consumption", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  const body = req.body as { kwh?: number | null; m3?: number | null };
  updateRealEstateExpenseConsumption(expenseEntryId, {
    kwh: body.kwh ?? null,
    m3: body.m3 ?? null,
  });
  res.status(204).send();
}));

app.delete("/api/flows/expenses/real-estate/entries/:expenseEntryId", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  deleteRealEstateExpenseEntry(expenseEntryId);
  res.status(204).send();
}));

app.patch("/api/flows/expenses/credit-card/purchase-notes", writeHandler((req, res) => {
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
  const result = setCcExpensePurchaseNote({
    accountId,
    purchaseKey,
    notes: body.notes,
  });
  res.json({ account_id: accountId, purchase_key: purchaseKey, notes: result.notes });
}));

app.post("/api/flows/expenses/vendor-branch-choice", writeHandler((req, res) => {
  const body = req.body as { key?: string; display?: string };
  const key = String(body.key ?? "").trim();
  const display = String(body.display ?? "").trim();
  if (!key || !display) {
    res.status(400).json({ error: "key and display required" });
    return;
  }
  saveVendorBranchChoice(key, display);
  res.json({ ok: true });
}));

app.put("/api/flows/expenses/credit-card/purchase-big-group", writeHandler((req, res) => {
  const body = req.body as {
    purchase_key?: string;
    group_slug?: string | null;
  };
  const purchaseKey = String(body.purchase_key ?? "").trim();
  if (!purchaseKey) {
    res.status(400).json({ error: "purchase_key required" });
    return;
  }
  const result = setCcExpensePurchaseBigGroup({
    purchaseKey,
    groupSlug: body.group_slug,
  });
  res.json({
    purchase_key: purchaseKey,
    group_slug: result.group_slug,
  });
}));

app.post("/api/flows/expenses/credit-card/big-groups", writeHandler((req, res) => {
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!label) {
    res.status(400).json({ error: "label required" });
    return;
  }
  const group = createCcExpenseBigGroup(label);
  res.status(201).json(group);
}));

app.patch("/api/flows/expenses/credit-card/big-groups/:slug", writeHandler((req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  const body = req.body as { label?: string };
  const label = String(body.label ?? "").trim();
  if (!slug || !label) {
    res.status(400).json({ error: "slug and label required" });
    return;
  }
  const group = renameCcExpenseBigGroup(slug, label);
  res.json(group);
}));

app.delete("/api/flows/expenses/credit-card/big-groups/:slug", writeHandler((req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  deleteCcExpenseBigGroup(slug);
  res.status(204).send();
}));

app.patch("/api/flows/expenses/credit-card/lines/:lineId/category", writeHandler((req, res) => {
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
    source?: "cc" | "checking" | "manual" | "payslip";
    /** «Específico»: the line's link (`category_link`), so the change writes the specific rule. */
    rule_link?: { kind?: string; key?: string } | null;
  };
  const categorySlug = body.category_slug != null ? String(body.category_slug).trim() : "";
  const unique = !!body.unique;
  const clearCategory = body.clear_category === true;
  const ruleLink =
    body.rule_link != null
      ? { kind: String(body.rule_link.kind ?? "") as CategoryRuleLinkKind, key: String(body.rule_link.key ?? "") }
      : null;
  const bodySource = body.source;
  const source =
    bodySource === "checking" || bodySource === "cc" || bodySource === "manual" || bodySource === "payslip"
      ? bodySource
      : undefined;
  const result = assignFlowExpenseLineCategory({
    lineId,
    source,
    unique,
    categorySlug: categorySlug || null,
    clearCategory,
    ruleLink,
  });
  res.json(result);
}));

/** Stale external sources + last sync state (AFP / Fintual / BCentral BDE). */
}
