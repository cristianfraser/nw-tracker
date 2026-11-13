import { useMutation, useQueryClient, type QueryClient, type QueryFilters } from "@tanstack/react-query";
import { api } from "../api";
import type {
  ManualExpenseInput,
  FlowCcExpenseLineRow,
  FlowCcExpenseLineSource,
  AccountDetailBundleResponse,
  CcExpenseBigGroupDto,
} from "../types";
import {
  expenseLineMatchesCategoryPatch,
  expenseLineMatchesPurchaseKey,
  expenseLineMatchesPurchaseBigGroupPatch,
} from "../ccExpenseLineBuckets";
import { queryKeys, type DisplayUnit } from "./keys";
import { invalidateResources, resources } from "./resources";

/** Any cached payload carrying expense lines (every `GET /api/flows/expenses/lines` selector). */
type WithLines = { lines: FlowCcExpenseLineRow[] };
/** Any cached payload carrying the big-group catalog (the lines lists and the summary). */
type WithBigGroups = { big_groups: CcExpenseBigGroupDto[] };

/** Every cached lines list, whatever its unit or selector. */
const LINE_QUERIES: QueryFilters = { queryKey: queryKeys.flowsExpensesLinesAll() };
/** The caches holding the big-group catalog. */
const BIG_GROUP_CATALOG_QUERIES: readonly QueryFilters[] = [
  LINE_QUERIES,
  { queryKey: queryKeys.flowsExpensesSummaryAll() },
];

/** The cached data of a set of queries, to restore on a failed write. */
type QueriesSnapshot = (readonly [readonly unknown[], unknown])[];

/**
 * Cancels every query of `filters`, snapshots them and applies `update` to each that holds data:
 * an optimistic patch reaches every list a line shows in (a month, a facturación, a big group …).
 */
async function patchQueries<T>(
  queryClient: QueryClient,
  filters: readonly QueryFilters[],
  update: (data: T) => T
): Promise<QueriesSnapshot> {
  await Promise.all(filters.map((f) => queryClient.cancelQueries(f)));
  const previous: QueriesSnapshot = filters.flatMap((f) => queryClient.getQueriesData(f));
  setQueries(queryClient, filters, update);
  return previous;
}

function setQueries<T>(queryClient: QueryClient, filters: readonly QueryFilters[], update: (data: T) => T): void {
  for (const f of filters) {
    queryClient.setQueriesData<T>(f, (old) => (old == null ? old : update(old)));
  }
}

function restoreQueries(queryClient: QueryClient, previous: QueriesSnapshot | undefined): void {
  for (const [key, data] of previous ?? []) queryClient.setQueryData(key, data);
}

export type PatchCcExpenseLineCategoryVars = {
  lineId: number;
  source: FlowCcExpenseLineSource;
  unique: boolean;
  category_slug?: string;
  clear_category?: boolean;
  /** «Específico»: the rule for the merchant + this link instead of the merchant's general rule. */
  rule_link?: { kind: "receipt" | "app" | "recipient"; key: string } | null;
};

function findCcExpenseCategoryPatchAnchor(
  lines: readonly FlowCcExpenseLineRow[],
  targetLineId: number,
  source: FlowCcExpenseLineSource
): FlowCcExpenseLineRow | undefined {
  return lines.find((ln) => ln.source === source && expenseLineMatchesCategoryPatch(ln, targetLineId));
}

/** The edited line as any cached list holds it (the anchor that names its purchase). */
function findCcExpenseCategoryPatchAnchorInCache(
  queryClient: QueryClient,
  targetLineId: number,
  source: FlowCcExpenseLineSource
): FlowCcExpenseLineRow | undefined {
  for (const [, data] of queryClient.getQueriesData<WithLines>(LINE_QUERIES)) {
    if (!data) continue;
    const anchor = findCcExpenseCategoryPatchAnchor(data.lines, targetLineId, source);
    if (anchor) return anchor;
  }
  return undefined;
}

export function applyCcExpenseLineCategoryPatch<T extends WithLines>(
  data: T | undefined,
  vars: PatchCcExpenseLineCategoryVars,
  anchor?: FlowCcExpenseLineRow
): T | undefined {
  if (!data) return data;
  const anchorLine = anchor ?? findCcExpenseCategoryPatchAnchor(data.lines, vars.lineId, vars.source);
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesCategoryPatch(ln, vars.lineId, anchorLine, vars.source)) {
        return ln;
      }
      let category_slug = ln.category_slug;
      if (vars.clear_category) category_slug = "unclassified";
      else if (vars.category_slug) category_slug = vars.category_slug;
      return { ...ln, category_slug, category_unique: vars.unique };
    }),
  };
}

export function applyCcExpenseLineCategoryPatchFromServer<T extends WithLines>(
  data: T | undefined,
  opts: {
    accountId: number;
    purchaseKey: string;
    category_slug: string;
    unique: boolean;
  }
): T | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesPurchaseKey(ln, opts.accountId, opts.purchaseKey)) {
        return ln;
      }
      return {
        ...ln,
        category_slug: opts.category_slug,
        category_unique: opts.unique,
      };
    }),
  };
}

/** A card write: its account page, the expense lines and the deposits. */
function cardWriteResources(accountId: string | number, displayUnit: DisplayUnit) {
  return [resources.accountPage(accountId, displayUnit), resources.expenseLines(), resources.deposits()];
}

export function usePatchCcExpenseLineCategoryMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: PatchCcExpenseLineCategoryVars) =>
      api.assignCcExpenseLineCategory(vars.lineId, {
        source: vars.source,
        unique: vars.unique,
        ...(vars.category_slug ? { category_slug: vars.category_slug } : {}),
        ...(vars.clear_category ? { clear_category: true } : {}),
      }),
    onMutate: async (vars) => {
      // One anchor for every list: a sibling line of the purchase may sit in a list the edited
      // line is not in.
      const anchor = findCcExpenseCategoryPatchAnchorInCache(queryClient, vars.lineId, vars.source);
      const previous = await patchQueries<WithLines>(queryClient, [LINE_QUERIES], (old) =>
        applyCcExpenseLineCategoryPatch(old, vars, anchor)!
      );
      return { previous, anchor };
    },
    onSuccess: (result, vars, context) => {
      const anchor = context?.anchor;
      setQueries<WithLines>(queryClient, [LINE_QUERIES], (old) => {
        if (anchor && result.purchase_key) {
          return applyCcExpenseLineCategoryPatchFromServer(old, {
            accountId: anchor.account_id,
            purchaseKey: result.purchase_key,
            category_slug: result.category_slug,
            unique: result.unique,
          })!;
        }
        return applyCcExpenseLineCategoryPatch(old, {
          lineId: vars.lineId,
          source: vars.source,
          unique: result.unique,
          category_slug: result.category_slug,
          clear_category: vars.clear_category,
        })!;
      });
    },
    onError: (_err, _vars, context) => {
      restoreQueries(queryClient, context?.previous);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseLines());
    },
  });
}

export type PatchCcExpensePurchaseNoteVars = {
  account_id: number;
  purchase_key?: string;
  statement_line_id?: number;
  notes: string;
};

export function applyCcExpensePurchaseNotePatch<T extends WithLines>(
  data: T | undefined,
  vars: PatchCcExpensePurchaseNoteVars & { purchase_key: string }
): T | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesPurchaseKey(ln, vars.account_id, vars.purchase_key)) {
        return ln;
      }
      return { ...ln, purchase_notes: vars.notes };
    }),
  };
}

export function applyCcPurchaseNotePatchToDetail(
  data: AccountDetailBundleResponse | undefined,
  purchaseKey: string,
  notes: string
): AccountDetailBundleResponse | undefined {
  if (!data) return data;
  const patch = <P extends { expense_purchase_key?: string }>(rows: P[]): P[] =>
    rows.map((p) => (p.expense_purchase_key === purchaseKey ? { ...p, purchase_notes: notes } : p));
  return {
    ...data,
    ccLedger: {
      ...data.ccLedger,
      purchases: patch(data.ccLedger.purchases),
      purchases_completed: patch(data.ccLedger.purchases_completed),
    },
  };
}

export function usePatchCcExpensePurchaseNoteMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: PatchCcExpensePurchaseNoteVars) =>
      api.patchCcExpensePurchaseNote(vars),
    onMutate: async (vars) => {
      const purchaseKey = vars.purchase_key ?? "";
      if (purchaseKey) {
        const previous = await patchQueries<WithLines>(queryClient, [LINE_QUERIES], (old) =>
          applyCcExpensePurchaseNotePatch(old, { ...vars, purchase_key: purchaseKey })!
        );
        return { previous };
      }
      if (vars.statement_line_id != null && vars.statement_line_id > 0) {
        const previous = await patchQueries<WithLines>(queryClient, [LINE_QUERIES], (old) => ({
          ...old,
          lines: old.lines.map((ln) =>
            ln.account_id !== vars.account_id || ln.statement_line_id !== vars.statement_line_id
              ? ln
              : { ...ln, purchase_notes: vars.notes }
          ),
        }));
        return { previous };
      }
      return { previous: undefined };
    },
    onSuccess: (result) => {
      setQueries<WithLines>(queryClient, [LINE_QUERIES], (old) =>
        applyCcExpensePurchaseNotePatch(old, {
          account_id: result.account_id,
          purchase_key: result.purchase_key,
          notes: result.notes,
        })!
      );
      // The card page's purchase tables show the same note (a plan's `expense_purchase_key`).
      queryClient.setQueriesData<AccountDetailBundleResponse>(
        { queryKey: queryKeys.accountDetailAll(String(result.account_id)) },
        (old) => applyCcPurchaseNotePatchToDetail(old, result.purchase_key, result.notes)
      );
    },
    onSettled: () => {
      // The note is patched in place on the Expenses page; the dashboard list refetches.
      void invalidateResources(queryClient, [{ queryKey: queryKeys.latestMovementsAll() }]);
    },
    onError: (_err, _vars, context) => {
      restoreQueries(queryClient, context?.previous);
    },
  });
}

/** Alias — category assignment and «Único» share the same PATCH endpoint. */
export function useAssignCcExpenseLineCategory() {
  return usePatchCcExpenseLineCategoryMutation();
}

export type PutCcExpensePurchaseBigGroupVars = {
  purchase_key: string;
  group_slug: string | null;
};

export function applyCcExpensePurchaseBigGroupPatch<T extends WithLines>(
  data: T | undefined,
  vars: PutCcExpensePurchaseBigGroupVars
): T | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesPurchaseBigGroupPatch(ln, vars.purchase_key)) {
        return ln;
      }
      return { ...ln, big_group_slug: vars.group_slug };
    }),
  };
}

/** The branch the user picks for a cut merchant name; the server rebuilds the rows' names. */
export function usePostVendorBranchChoiceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { key: string; display: string }) => api.postVendorBranchChoice(vars),
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseLineRows());
    },
  });
}

export function usePutCcExpensePurchaseBigGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: PutCcExpensePurchaseBigGroupVars) =>
      api.putCcExpensePurchaseBigGroup(vars),
    onMutate: async (vars) => {
      const previous = await patchQueries<WithLines>(queryClient, [LINE_QUERIES], (old) =>
        applyCcExpensePurchaseBigGroupPatch(old, vars)!
      );
      return { previous };
    },
    onSuccess: (result) => {
      setQueries<WithLines>(queryClient, [LINE_QUERIES], (old) =>
        applyCcExpensePurchaseBigGroupPatch(old, {
          purchase_key: result.purchase_key,
          group_slug: result.group_slug,
        })!
      );
    },
    onSettled: () => {
      // The gastos views leave excluded big groups out of the chart and carry each group's
      // usage; the summary lists the active groups: recompute both.
      void invalidateResources(queryClient, resources.expenseBigGroups());
    },
    onError: (_err, _vars, context) => {
      restoreQueries(queryClient, context?.previous);
    },
  });
}

export function useCreateCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (label: string) => api.createCcExpenseBigGroup(label),
    onSuccess: (group) => {
      setQueries<WithBigGroups>(queryClient, BIG_GROUP_CATALOG_QUERIES, (old) => {
        if (old.big_groups.some((g) => g.slug === group.slug)) return old;
        return {
          ...old,
          big_groups: [...old.big_groups, group].sort(
            (a, b) => a.sort_order - b.sort_order || a.label.localeCompare(b.label)
          ),
        };
      });
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseBigGroupCatalog());
    },
  });
}

export function useRenameCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (vars: { slug: string; label: string }) =>
      api.renameCcExpenseBigGroup(vars.slug, vars.label),
    onMutate: async (vars) => {
      const previous = await patchQueries<WithBigGroups>(queryClient, BIG_GROUP_CATALOG_QUERIES, (old) => ({
        ...old,
        big_groups: old.big_groups.map((g) => (g.slug === vars.slug ? { ...g, label: vars.label } : g)),
      }));
      return { previous };
    },
    onError: (_err, _vars, context) => {
      restoreQueries(queryClient, context?.previous);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseBigGroupCatalog());
    },
  });
}

export function useDeleteCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (slug: string) => api.deleteCcExpenseBigGroup(slug),
    onMutate: async (slug) => {
      const previous = await patchQueries<WithBigGroups & Partial<WithLines>>(
        queryClient,
        BIG_GROUP_CATALOG_QUERIES,
        (old) => ({
          ...old,
          big_groups: old.big_groups.filter((g) => g.slug !== slug),
          ...(old.lines
            ? {
                lines: old.lines.map((ln) =>
                  ln.big_group_slug === slug ? { ...ln, big_group_slug: null } : ln
                ),
              }
            : {}),
        })
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      restoreQueries(queryClient, context?.previous);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseBigGroupCatalog());
    },
  });
}

export function useDeleteCcPurchaseMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (purchaseId: number) => api.deleteCcPurchase(opts.accountId, purchaseId),
    onSettled: () => {
      void invalidateResources(queryClient, ...cardWriteResources(opts.accountId, opts.displayUnit));
    },
  });
}

/** A manual plan's cuota count, changed from its row. */
export function useUpdateCcPurchaseCuotasMutation(opts: { accountId: number; displayUnit: DisplayUnit }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ purchaseId, cuotas_totales }: { purchaseId: number; cuotas_totales: number }) =>
      api.updateCcPurchaseCuotas(opts.accountId, purchaseId, cuotas_totales),
    onSettled: () => {
      void invalidateResources(queryClient, ...cardWriteResources(opts.accountId, opts.displayUnit));
    },
  });
}

export function useDeleteCcStatementLineMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: number) => api.deleteCcStatementLine(opts.accountId, lineId),
    onSettled: () => {
      void invalidateResources(queryClient, ...cardWriteResources(opts.accountId, opts.displayUnit));
    },
  });
}

export function useMakeStatementLineInstallmentMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, cuotas_totales }: { lineId: number; cuotas_totales: number }) =>
      api.makeStatementLineInstallment(opts.accountId, lineId, cuotas_totales),
    onSettled: () => {
      void invalidateResources(queryClient, ...cardWriteResources(opts.accountId, opts.displayUnit));
    },
  });
}

export function useAccountImportMutation(opts: { accountId: number; displayUnit: DisplayUnit }) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<Record<string, unknown>>) => run(),
    onSettled: () => {
      void invalidateResources(queryClient, ...cardWriteResources(opts.accountId, opts.displayUnit));
    },
  });
}

export function useLinkRealEstateExpenseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: { expense_entry_id: number; purchase_key: string }) =>
      api.linkRealEstateExpense(body),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.realEstateLinkCandidates());
    },
  });
}

export function useUnmatchRealEstateExpenseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (expenseEntryId: number) => api.unmatchRealEstateExpense(expenseEntryId),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.realEstateLinkCandidates());
    },
  });
}

export function useAssignRealEstatePurchaseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      purchase_key: string;
      account_slug: import("../types").ExpenseApartmentSlug;
      kind: string;
      bill_month?: string;
    }) => api.assignRealEstatePurchase(body),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.realEstateCandidates());
    },
  });
}

export function useCreateRealEstatePlaceMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      slug: string;
      label: string;
      active_from?: string | null;
      active_to?: string | null;
      property_account_id?: number | null;
      dfl2?: boolean;
      dfl2_built_m2?: number | null;
      dfl2_reception_year?: number | null;
    }) => api.createRealEstatePlace(body),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.sidebarNav(), resources.income());
    },
  });
}

/** A place's DFL-2 declaration (its rent's F22 treatment and the contribuciones halving). */
export function useSetRealEstatePlaceDfl2Mutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { slug: string; dfl2: boolean; dfl2_built_m2: number | null; dfl2_reception_year: number | null }) => {
      const { slug, ...body } = vars;
      return api.setRealEstatePlaceDfl2(slug, body);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.income(), resources.taxReturn());
    },
  });
}

export function useUpdateRealEstateBillMonthMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { expense_entry_id: number; bill_month: string }) =>
      api.updateRealEstateBillMonth(vars.expense_entry_id, { bill_month: vars.bill_month }),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.realEstateLinkCandidates());
    },
  });
}

export function useUpdateRealEstateMonthsCoveredMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { expense_entry_id: number; months_covered: number }) =>
      api.updateRealEstateMonthsCovered(vars.expense_entry_id, { months_covered: vars.months_covered }),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses());
    },
  });
}

export function useUpdateRealEstateConsumptionMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { expense_entry_id: number; kwh: number | null; m3: number | null }) =>
      api.updateRealEstateConsumption(vars.expense_entry_id, { kwh: vars.kwh, m3: vars.m3 }),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses());
    },
  });
}

export function useDeleteRealEstateExpenseEntryMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (expenseEntryId: number) => api.deleteRealEstateExpenseEntry(expenseEntryId),
    onSettled: () => {
      void invalidateResources(queryClient, resources.realEstateExpenses(), resources.realEstateCandidates());
    },
  });
}

export function usePatchWorkEarningMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      id: number;
      earning_type?: import("../types").PayrollEarningType;
      movement_id?: number | null;
    }) => {
      const { id, ...body } = vars;
      return api.patchWorkEarning(id, body);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.income());
    },
  });
}

export function usePatchIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      movement_id: number;
      income_kind?: import("../types").IncomeKind;
      rent_place_slug?: string;
      excluded?: boolean;
      force_include?: boolean;
      note?: string | null;
    }) => {
      const { movement_id, ...body } = vars;
      return api.patchIncomeMovement(movement_id, body);
    },
    onSettled: () => {
      void invalidateResources(queryClient, resources.income(), resources.expenseLines(), resources.taxReturn());
    },
  });
}

/** Marks a checking credit as a refund of spending, or (`refund: false`) returns it to income. */
export function useIncomeRefundMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { movement_id: number; refund: boolean }) =>
      vars.refund ? api.markIncomeRefund(vars.movement_id) : api.unmarkIncomeRefund(vars.movement_id),
    onSettled: () => {
      // A refund is a negative line on the Expenses page.
      void invalidateResources(queryClient, resources.income(), resources.expenseLines());
    },
  });
}

export function useForceIncludeIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (movement_id: number) => api.forceIncludeIncomeMovement(movement_id),
    onSettled: () => {
      void invalidateResources(queryClient, resources.income());
    },
  });
}

export function useRestoreIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (movement_id: number) => api.restoreIncomeMovement(movement_id),
    onSettled: () => {
      void invalidateResources(queryClient, resources.income());
    },
  });
}

export function useUpsertCcFacturadoFinancingLinkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      financed_account_id: number;
      financed_billing_month: string;
      financing: { account_id: number; purchase_key: string }[];
    }) => api.upsertCcFacturadoFinancingLink(body),
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseLines(), resources.financingLinks());
    },
  });
}

export function useDeleteCcFacturadoFinancingLinkMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteCcFacturadoFinancingLink(id),
    onSettled: () => {
      void invalidateResources(queryClient, resources.expenseLines(), resources.financingLinks());
    },
  });
}

/** Replaces a card or checking line's pieces; the expense lines and gastos views refetch. */
export function useSaveExpenseLinePiecesMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: Parameters<typeof api.putExpenseLinePieces>[0]) => api.putExpenseLinePieces(vars),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.expenseLines(), resources.expenseLinePieces());
    },
  });
}

/** Creates a manual expense (no id) or edits one; the expense lines and gastos views refetch. */
export function useSaveManualExpenseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: { id: number | null; input: ManualExpenseInput }): Promise<void> => {
      if (vars.id == null) await api.createManualExpense(vars.input);
      else await api.updateManualExpense(vars.id, vars.input);
    },
    onSuccess: () => {
      void invalidateResources(queryClient, resources.expenseLines());
    },
  });
}

export function useDeleteManualExpenseMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteManualExpense(id),
    onSuccess: () => {
      void invalidateResources(queryClient, resources.expenseLines());
    },
  });
}
