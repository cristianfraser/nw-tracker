/** Flows: deposits, income, work earnings, expenses (manual, CC, real estate). Split verbatim from index.ts; paths unchanged. */
import {
  cachedExpensesSpentLines,
  cachedExpensesSpentPayload,
  ExpensesSpentRequestError,
  parseSpentLinesSelection,
  parseSpentOptions,
  parseSpentRange,
} from "../flowsExpensesSpent.js";
import { syncCardToCardPaymentTransfers } from "../cardToCardPayments.js";
import { assertDemoManualExpenseDescription } from "../demoWritePolicy.js";
import express from "express";
import { InputError, writeHandler } from "../inputError.js";
import { requestExpenseLinkSync, withExpenseLinkSyncDeferred } from "../expenseLinkSync.js";
import { buildPayrollBreakdown } from "../payrollBreakdown.js";
import { buildPayslipChecks } from "../payslipChecks.js";
import { db } from "../db.js";
import { saveVendorBranchChoice } from "../vendorCatalog.js";
import {
  bigGroupLabelSchema,
  expenseLineCategoryPatchSchema,
  expenseLinePiecesPutSchema,
  financingLinkUpsertSchema,
  incomeMovementPatchSchema,
  incomeRefundRequestSchema,
  manualExpenseInputSchema,
  purchaseBigGroupPutSchema,
  purchaseNotePatchSchema,
  realEstateAssignSchema,
  realEstateBillMonthPatchSchema,
  realEstateConsumptionPatchSchema,
  realEstateLinkPutSchema,
  realEstateMonthsCoveredPatchSchema,
  realEstatePlaceCreateSchema,
  realEstatePlaceDfl2PatchSchema,
  refundLinkPutSchema,
  vendorBranchChoiceSchema,
  workEarningPatchSchema,
} from "nw-tracker-contracts/requests/flows";
import { parseBody } from "./shared.js";
import { buildDepositsReconciliationPagePayload } from "../flowsDepositsReconciliation.js";
import { buildFlowsDepositsResponse } from "../flowsDeposits.js";
import { cachedMortgageCarryingEvents } from "../flowsMortgageCarrying.js";
import {
  cachedFlowsExpenseLinesList,
  cachedFlowsExpensesFinancingCandidates,
  cachedFlowsExpensesSummary,
  ExpenseLinesRequestError,
  pageOfExpenseLinesList,
  parseExpenseLinesPage,
  parseExpenseLinesSelector,
} from "../flowsExpenseLineLists.js";
import { buildFlowsPlPayload } from "../flowsPl.js";
import { buildFlowsIncomeAggregates, buildFlowsOverviewPayload } from "../flowsOverview.js";
import { DAILY_SERIES_MAX_DAYS } from "../dailySeries.js";
import { listPropertyAccounts } from "../accountRoles.js";
import { assignFlowExpenseLineCategory } from "../expenseAssignmentWrites.js";
import { cardRefundCandidatesResponse, linkCardRefund, unlinkCardRefund } from "../cardRefundLinkWrites.js";
import { getExpenseLinePieces, replaceExpenseLinePieces, type ExpenseLinePieceSource } from "../expenseLinePieces.js";
import { createManualExpense, deleteManualExpense, updateManualExpense } from "../flowsManualExpenses.js";
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
import { buildFlowsCheckingIncomePayload, flowsCheckingIncomeListsInUnit } from "../flowsCheckingInflows.js";
import { markCheckingExpenseRefund, unmarkCheckingExpenseRefund } from "../checkingExpenseRefunds.js";
import { transferCounterpartiesByMovementSide, withTransferCounterparties } from "../bankTransferNotices.js";
import { checkingMovementShownName, loadDisplayNameContext } from "../expenseDisplayNames.js";
import {
  clearCheckingIncomeForceInclude,
  loadRentPlaceSlugByMovementId,
  restoreCheckingIncomeMovement,
  upsertCheckingIncomeMovementOverride,
} from "../flowsCheckingIncomeOverrides.js";
import { updatePayrollWorkEarning } from "../flowsPayrollWorkEarnings.js";
import {
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
import { requestDisplayUnit, roundToCurrency } from "../displayUnits.js";

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
app.get("/api/flows/deposits", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/deposits" });
  res.json(
    buildFlowsDepositsResponse(unit, {
      excludeCheckingAccounts: true,
      withMortgageCarrying: { clp: cachedMortgageCarryingEvents("clp"), unit: cachedMortgageCarryingEvents(unit) },
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
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/pl" });
  res.json(buildFlowsPlPayload(unit, days != null ? { days } : undefined));
});

app.get("/api/flows/overview", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/overview" });
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

app.get("/api/flows/deposits/reconciliation", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/deposits/reconciliation" });
  res.json(buildDepositsReconciliationPagePayload(unit));
});

app.get("/api/income", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/income" });
  const payload = buildFlowsCheckingIncomePayload();
  const inUnit = flowsCheckingIncomeListsInUnit(payload, unit);
  const counterparties = transferCounterpartiesByMovementSide();
  const nameCtx = loadDisplayNameContext([]);
  // Each credit with its payer (a transfer mail) and the one name it shows.
  const named = <L extends { movement_id: number; account_id: number; description: string }>(lines: L[]) =>
    withTransferCounterparties(lines, counterparties).map(({ description, ...l }) => {
      const { link_label: _link, ...names } = checkingMovementShownName(
        description,
        l.account_id,
        l.transfer_counterparty,
        nameCtx,
        `income credit ${l.movement_id}`
      );
      // The bank's description goes out only as the name's provenance (`name_detail`).
      return { ...l, ...names };
    });
  // A line with no rate on file shows «—»; the heading says how many its sum leaves out.
  const listTotal = (lines: readonly { amount: number | null }[]) => {
    let amount = 0;
    let unpriced = 0;
    for (const l of lines) {
      if (l.amount == null) unpriced += 1;
      else amount += l.amount;
    }
    return { amount: roundToCurrency(amount, unit), unpriced };
  };
  res.json({
    ...payload,
    unit,
    list_totals: {
      refund_lines: listTotal(inUnit.refund_lines),
      filtered_lines: listTotal(inUnit.filtered_lines),
      excluded_lines: listTotal(inUnit.excluded_lines),
    },
    lines: named(inUnit.lines),
    manual: inUnit.manual,
    work_earnings: inUnit.work_earnings,
    excluded_lines: named(inUnit.excluded_lines),
    filtered_lines: named(inUnit.filtered_lines),
    refund_lines: named(inUnit.refund_lines),
    payroll_breakdown: buildPayrollBreakdown(unit),
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
  const body = parseBody(workEarningPatchSchema, req);
  if (body.movement_id != null) {
    // Building the candidates may throw (a 500); a movement that is not one of them is the request's.
    const movementId = body.movement_id;
    if (!listPayrollLinkCandidates().some((c) => c.movement_id === movementId)) {
      res.status(400).json({ error: `movement ${movementId} is not an eligible checking income inflow` });
      return;
    }
  }
  const row = updatePayrollWorkEarning(id, {
    earning_type: body.earning_type ?? undefined,
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
  const body = parseBody(incomeMovementPatchSchema, req);
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
  const slug = parseBody(incomeRefundRequestSchema, req).category_slug;
  try {
    markCheckingExpenseRefund(movementId, slug || undefined);
    res.json({ ok: true, movement_id: movementId });
  } catch (e) {
    // `checkingExpenseRefunds.ts` states the answer on the errors a request can cause (an unknown
    // movement or category, a row that is no checking credit); anything else is a 500.
    const status = (e as { status?: unknown } | null)?.status;
    if (e instanceof Error && typeof status === "number") {
      res.status(status).json({ error: e.message });
      return;
    }
    throw e;
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
      `SELECT id, amount, currency, spent_on, category, note, import_batch_id, expense_account_id
       FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.get("/api/flows/expenses/lines", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/expenses/lines" });
  try {
    const selector = parseExpenseLinesSelector(req.query);
    const page = parseExpenseLinesPage(req.query, selector);
    const list = cachedFlowsExpenseLinesList(unit, selector);
    res.json(page ? pageOfExpenseLinesList(list, page) : list);
  } catch (err) {
    if (err instanceof ExpenseLinesRequestError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    throw err;
  }
});

app.get("/api/flows/expenses/summary", (req, res) => {
  res.json(cachedFlowsExpensesSummary(requestDisplayUnit(req.query, { surface: "/api/flows/expenses/summary" })));
});

app.get("/api/flows/expenses/financing-candidates", (req, res) => {
  res.json(
    cachedFlowsExpensesFinancingCandidates(
      requestDisplayUnit(req.query, { surface: "/api/flows/expenses/financing-candidates" })
    )
  );
});

app.get("/api/flows/expenses/spent", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/expenses/spent" });
  try {
    res.json(cachedExpensesSpentPayload(parseSpentOptions(req.query, unit), parseSpentRange(req.query.range)));
  } catch (err) {
    if (err instanceof ExpensesSpentRequestError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
});

app.get("/api/flows/expenses/spent/lines", (req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/expenses/spent/lines" });
  try {
    res.json(cachedExpensesSpentLines(parseSpentOptions(req.query, unit), parseSpentLinesSelection(req.query)));
  } catch (err) {
    if (err instanceof ExpensesSpentRequestError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
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
  const body = parseBody(expenseLinePiecesPutSchema, req);
  res.json(replaceExpenseLinePieces(body.source, body.line_id, body.pieces));
}));

app.post("/api/flows/expenses/manual", linkSyncingWrite((req, res) => {
  const body = parseBody(manualExpenseInputSchema, req);
  assertDemoManualExpenseDescription(body.description);
  res.status(201).json(createManualExpense(body));
}));

app.patch("/api/flows/expenses/manual/:id", linkSyncingWrite((req, res) => {
  const body = parseBody(manualExpenseInputSchema, req);
  assertDemoManualExpenseDescription(body.description);
  updateManualExpense(Number(req.params.id), body);
  res.json({ ok: true });
}));

app.delete("/api/flows/expenses/manual/:id", linkSyncingWrite((req, res) => {
  deleteManualExpense(Number(req.params.id));
  res.status(204).send();
}));

app.get("/api/flows/expenses/financing-links", (_req, res) => {
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

app.post("/api/flows/expenses/financing-links", writeHandler((req, res) => {
  const body = parseBody(financingLinkUpsertSchema, req);
  const link = upsertCcFacturadoFinancingLink({
    financedAccountId: body.financed_account_id,
    financedBillingMonth: body.financed_billing_month,
    financing: body.financing,
  });
  syncCardToCardPaymentTransfers();
  res.json({ ok: true, id: link.id });
}));

app.delete("/api/flows/expenses/financing-links/:id", writeHandler((req, res) => {
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
  const body = parseBody(realEstateLinkPutSchema, req);
  const link = manualLinkRealEstateExpense(body.expense_entry_id, body.purchase_key);
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
  const body = parseBody(realEstatePlaceCreateSchema, req);
  const place = createRealEstatePlace({
    slug: body.slug,
    label: body.label,
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
  const body = parseBody(realEstatePlaceDfl2PatchSchema, req);
  res.json(
    setRealEstatePlaceDfl2(String(req.params.slug), {
      dfl2: body.dfl2,
      builtM2: body.dfl2_built_m2 ?? null,
      receptionYear: body.dfl2_reception_year ?? null,
    })
  );
}));

/** The property accounts (the `property` role): candidates for a place's property_account_id link. */
app.get("/api/flows/expenses/real-estate/property-accounts", (_req, res) => {
  res.json({ accounts: listPropertyAccounts() });
});

app.post("/api/flows/expenses/real-estate/assign", writeHandler((req, res) => {
  const body = parseBody(realEstateAssignSchema, req);
  const result = assignPurchaseToRealEstateExpense({
    purchaseKey: body.purchase_key,
    accountSlug: body.account_slug,
    kind: body.kind,
    billMonth: body.bill_month,
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
  updateRealEstateExpenseBillMonth(expenseEntryId, parseBody(realEstateBillMonthPatchSchema, req).bill_month);
  res.status(204).send();
}));

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/months-covered", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  updateRealEstateExpenseMonthsCovered(expenseEntryId, parseBody(realEstateMonthsCoveredPatchSchema, req).months_covered);
  res.status(204).send();
}));

app.patch("/api/flows/expenses/real-estate/entries/:expenseEntryId/consumption", writeHandler((req, res) => {
  const expenseEntryId = Number(req.params.expenseEntryId);
  if (!Number.isFinite(expenseEntryId) || expenseEntryId <= 0) {
    res.status(400).json({ error: "invalid expense entry id" });
    return;
  }
  const body = parseBody(realEstateConsumptionPatchSchema, req);
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

app.patch("/api/flows/expenses/purchase-notes", writeHandler((req, res) => {
  const body = parseBody(purchaseNotePatchSchema, req);
  const accountId = body.account_id;
  // The schema holds one of the two: a key, else the statement line it is resolved from.
  const purchaseKey = body.purchase_key || resolveCcExpensePurchaseKey(body.statement_line_id!);
  const result = setCcExpensePurchaseNote({
    accountId,
    purchaseKey,
    notes: body.notes,
  });
  res.json({ account_id: accountId, purchase_key: purchaseKey, notes: result.notes });
}));

app.post("/api/flows/expenses/vendor-branch-choice", writeHandler((req, res) => {
  const { key, display } = parseBody(vendorBranchChoiceSchema, req);
  saveVendorBranchChoice(key, display);
  res.json({ ok: true });
}));

app.put("/api/flows/expenses/purchase-big-group", writeHandler((req, res) => {
  const body = parseBody(purchaseBigGroupPutSchema, req);
  const purchaseKey = body.purchase_key;
  const result = setCcExpensePurchaseBigGroup({
    purchaseKey,
    groupSlug: body.group_slug,
  });
  res.json({
    purchase_key: purchaseKey,
    group_slug: result.group_slug,
  });
}));

app.post("/api/flows/expenses/big-groups", writeHandler((req, res) => {
  const { label } = parseBody(bigGroupLabelSchema, req);
  const group = createCcExpenseBigGroup(label);
  res.status(201).json(group);
}));

app.patch("/api/flows/expenses/big-groups/:slug", writeHandler((req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  const { label } = parseBody(bigGroupLabelSchema, req);
  const group = renameCcExpenseBigGroup(slug, label);
  res.json(group);
}));

app.delete("/api/flows/expenses/big-groups/:slug", writeHandler((req, res) => {
  const slug = String(req.params.slug ?? "").trim();
  if (!slug) {
    res.status(400).json({ error: "slug required" });
    return;
  }
  deleteCcExpenseBigGroup(slug);
  res.status(204).send();
}));

function positiveIntParam(name: string, raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new InputError(`${name} must be a positive integer, got ${String(raw)}`);
  return n;
}

app.get("/api/flows/expenses/refund-candidates", writeHandler((req, res) => {
  const unit = requestDisplayUnit(req.query, { surface: "/api/flows/expenses/refund-candidates" });
  res.json(
    cardRefundCandidatesResponse(
      positiveIntParam("account_id", req.query.account_id),
      positiveIntParam("line_id", req.query.line_id),
      unit
    )
  );
}));

app.put("/api/flows/expenses/refund-links", writeHandler((req, res) => {
  const body = parseBody(refundLinkPutSchema, req);
  res.json(linkCardRefund({ accountId: body.account_id, lineId: body.line_id, purchaseLineId: body.purchase_line_id }));
}));

app.delete("/api/flows/expenses/refund-links", writeHandler((req, res) => {
  unlinkCardRefund({
    accountId: positiveIntParam("account_id", req.query.account_id),
    lineId: positiveIntParam("line_id", req.query.line_id),
  });
  res.status(204).send();
}));

app.patch("/api/flows/expenses/lines/:lineId/category", writeHandler((req, res) => {
  const route = "PATCH /api/flows/expenses/lines/:lineId/category";
  const lineId = Number(req.params.lineId);
  if (!Number.isFinite(lineId) || lineId === 0) {
    console.error(route, { lineId: req.params.lineId, reason: "line id must be non-zero finite" });
    res.status(400).json({ error: "invalid line id" });
    return;
  }
  const body = parseBody(expenseLineCategoryPatchSchema, req);
  const result = assignFlowExpenseLineCategory({
    lineId,
    source: body.source,
    unique: body.unique === true,
    categorySlug: body.category_slug || null,
    clearCategory: body.clear_category === true,
    ruleLink: body.rule_link ?? null,
  });
  res.json(result);
}));

/** Stale external sources + last sync state (AFP / Fintual / BCentral BDE). */
}
