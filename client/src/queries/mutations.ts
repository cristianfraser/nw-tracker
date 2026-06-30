import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type {
  FlowCcExpenseLineRow,
  FlowCcExpenseLineSource,
  FlowsCreditCardExpensesResponse,
} from "../types";
import {
  expenseLineCategoryTargetId,
  expenseLineMatchesCategoryPatch,
  expenseLineMatchesCategoryPurchaseKey,
  expenseLineMatchesPurchaseNotePatch,
  expenseLineMatchesPurchaseBigGroupPatch,
} from "../ccExpenseLineBuckets";
import { queryKeys, type DisplayUnit } from "./keys";

export type PatchCcExpenseLineCategoryVars = {
  lineId: number;
  source: FlowCcExpenseLineSource;
  unique: boolean;
  category_slug?: string;
  clear_category?: boolean;
};

function lineMatchesCategoryTargetId(
  ln: FlowCcExpenseLineRow,
  targetLineId: number
): boolean {
  return (
    expenseLineCategoryTargetId(ln) === targetLineId ||
    ln.statement_line_id === targetLineId ||
    ln.category_statement_line_id === targetLineId
  );
}

function findCcExpenseCategoryPatchAnchor(
  lines: readonly FlowCcExpenseLineRow[],
  targetLineId: number,
  source: FlowCcExpenseLineSource
): FlowCcExpenseLineRow | undefined {
  return lines.find((ln) => ln.source === source && lineMatchesCategoryTargetId(ln, targetLineId));
}

export function applyCcExpenseLineCategoryPatch(
  data: FlowsCreditCardExpensesResponse | undefined,
  vars: PatchCcExpenseLineCategoryVars
): FlowsCreditCardExpensesResponse | undefined {
  if (!data) return data;
  const anchorLine = findCcExpenseCategoryPatchAnchor(data.lines, vars.lineId, vars.source);
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

export function applyCcExpenseLineCategoryPatchFromServer(
  data: FlowsCreditCardExpensesResponse | undefined,
  opts: {
    accountId: number;
    purchaseKey: string;
    category_slug: string;
    unique: boolean;
  }
): FlowsCreditCardExpensesResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesCategoryPurchaseKey(ln, opts.accountId, opts.purchaseKey)) {
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

function invalidateAccountDetailBundle(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | number,
  displayUnit: DisplayUnit,
  extraCcOffsetsKey: string
) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.accountDetail(String(accountId), displayUnit, "monthly", extraCcOffsetsKey),
  });
}

function invalidateAccountAndFlowQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | number,
  displayUnit: DisplayUnit,
  extraCcOffsetsKey: string
) {
  invalidateAccountDetailBundle(queryClient, accountId, displayUnit, extraCcOffsetsKey);
  void queryClient.invalidateQueries({ queryKey: queryKeys.flowsCreditCardExpenses() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.flowsDeposits() });
}

export function usePatchCcExpenseLineCategoryMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (vars: PatchCcExpenseLineCategoryVars) =>
      api.assignCcExpenseLineCategory(vars.lineId, {
        source: vars.source,
        unique: vars.unique,
        ...(vars.category_slug ? { category_slug: vars.category_slug } : {}),
        ...(vars.clear_category ? { clear_category: true } : {}),
      }),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FlowsCreditCardExpensesResponse>(queryKey);
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) =>
        applyCcExpenseLineCategoryPatch(old, vars)
      );
      return { previous };
    },
    onSuccess: (result, vars) => {
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) => {
        if (!old) return old;
        const anchor = findCcExpenseCategoryPatchAnchor(old.lines, vars.lineId, vars.source);
        if (anchor && result.purchase_key) {
          return applyCcExpenseLineCategoryPatchFromServer(old, {
            accountId: anchor.account_id,
            purchaseKey: result.purchase_key,
            category_slug: result.category_slug,
            unique: result.unique,
          });
        }
        return applyCcExpenseLineCategoryPatch(old, {
          lineId: vars.lineId,
          source: vars.source,
          unique: result.unique,
          category_slug: result.category_slug,
          clear_category: vars.clear_category,
        });
      });
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export type PatchCcExpensePurchaseNoteVars = {
  account_id: number;
  purchase_key?: string;
  statement_line_id?: number;
  notes: string;
};

export function applyCcExpensePurchaseNotePatch(
  data: FlowsCreditCardExpensesResponse | undefined,
  vars: PatchCcExpensePurchaseNoteVars & { purchase_key: string }
): FlowsCreditCardExpensesResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesPurchaseNotePatch(ln, vars.account_id, vars.purchase_key)) {
        return ln;
      }
      return { ...ln, purchase_notes: vars.notes };
    }),
  };
}

export function usePatchCcExpensePurchaseNoteMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (vars: PatchCcExpensePurchaseNoteVars) =>
      api.patchCcExpensePurchaseNote(vars),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FlowsCreditCardExpensesResponse>(queryKey);
      const purchaseKey = vars.purchase_key ?? "";
      if (purchaseKey) {
        queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) =>
          applyCcExpensePurchaseNotePatch(old, { ...vars, purchase_key: purchaseKey })
        );
      } else if (vars.statement_line_id != null && vars.statement_line_id > 0) {
        queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) => {
          if (!old) return old;
          return {
            ...old,
            lines: old.lines.map((ln) => {
              if (
                ln.account_id !== vars.account_id ||
                ln.statement_line_id !== vars.statement_line_id
              ) {
                return ln;
              }
              return { ...ln, purchase_notes: vars.notes };
            }),
          };
        });
      }
      return { previous };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) =>
        applyCcExpensePurchaseNotePatch(old, {
          account_id: result.account_id,
          purchase_key: result.purchase_key,
          notes: result.notes,
        })
      );
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

/** Alias — category assignment and «Único» share the same PATCH endpoint. */
export function useAssignCcExpenseLineCategory() {
  return usePatchCcExpenseLineCategoryMutation();
}

/** Alias for toggling the «Único» flag on a credit-card expense line. */
export function useMarkCcExpenseLineUniqueMutation() {
  return usePatchCcExpenseLineCategoryMutation();
}

export type PutCcExpensePurchaseBigGroupVars = {
  account_id: number;
  purchase_key: string;
  group_slug: string | null;
};

export function applyCcExpensePurchaseBigGroupPatch(
  data: FlowsCreditCardExpensesResponse | undefined,
  vars: PutCcExpensePurchaseBigGroupVars
): FlowsCreditCardExpensesResponse | undefined {
  if (!data) return data;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesPurchaseBigGroupPatch(ln, vars.account_id, vars.purchase_key)) {
        return ln;
      }
      return { ...ln, big_group_slug: vars.group_slug };
    }),
  };
}

export function usePutCcExpensePurchaseBigGroupMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (vars: PutCcExpensePurchaseBigGroupVars) =>
      api.putCcExpensePurchaseBigGroup(vars),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FlowsCreditCardExpensesResponse>(queryKey);
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) =>
        applyCcExpensePurchaseBigGroupPatch(old, vars)
      );
      return { previous };
    },
    onSuccess: (result) => {
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) =>
        applyCcExpensePurchaseBigGroupPatch(old, {
          account_id: result.account_id,
          purchase_key: result.purchase_key,
          group_slug: result.group_slug,
        })
      );
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
  });
}

export function useCreateCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (label: string) => api.createCcExpenseBigGroup(label),
    onSuccess: (group) => {
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) => {
        if (!old) return old;
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
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useRenameCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (vars: { slug: string; label: string }) =>
      api.renameCcExpenseBigGroup(vars.slug, vars.label),
    onMutate: async (vars) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FlowsCreditCardExpensesResponse>(queryKey);
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          big_groups: old.big_groups.map((g) =>
            g.slug === vars.slug ? { ...g, label: vars.label } : g
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useDeleteCcExpenseBigGroupMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsCreditCardExpenses();

  return useMutation({
    mutationFn: (slug: string) => api.deleteCcExpenseBigGroup(slug),
    onMutate: async (slug) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<FlowsCreditCardExpensesResponse>(queryKey);
      queryClient.setQueryData<FlowsCreditCardExpensesResponse>(queryKey, (old) => {
        if (!old) return old;
        return {
          ...old,
          big_groups: old.big_groups.filter((g) => g.slug !== slug),
          lines: old.lines.map((ln) =>
            ln.big_group_slug === slug ? { ...ln, big_group_slug: null } : ln
          ),
        };
      });
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(queryKey, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
  });
}

export function useDeleteCcPurchaseMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (purchaseId: number) => api.deleteCcPurchase(opts.accountId, purchaseId),
    onSettled: () => {
      invalidateAccountAndFlowQueries(
        queryClient,
        opts.accountId,
        opts.displayUnit,
        opts.extraCcOffsetsKey
      );
    },
  });
}

export function useDeleteCcStatementLineMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (lineId: number) => api.deleteCcStatementLine(opts.accountId, lineId),
    onSettled: () => {
      invalidateAccountAndFlowQueries(
        queryClient,
        opts.accountId,
        opts.displayUnit,
        opts.extraCcOffsetsKey
      );
    },
  });
}

export function useMakeStatementLineInstallmentMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ lineId, cuotas_totales }: { lineId: number; cuotas_totales: number }) =>
      api.makeStatementLineInstallment(opts.accountId, lineId, cuotas_totales),
    onSettled: () => {
      invalidateAccountAndFlowQueries(
        queryClient,
        opts.accountId,
        opts.displayUnit,
        opts.extraCcOffsetsKey
      );
    },
  });
}

export function useAccountImportMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey?: string;
}) {
  const queryClient = useQueryClient();
  const extraCcOffsetsKey = opts.extraCcOffsetsKey ?? "{}";
  return useMutation({
    mutationFn: (run: () => Promise<Record<string, unknown>>) => run(),
    onSettled: () => {
      invalidateAccountAndFlowQueries(
        queryClient,
        opts.accountId,
        opts.displayUnit,
        extraCcOffsetsKey
      );
    },
  });
}

export function useLinkRealEstateExpenseMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsRealEstateExpenses();
  return useMutation({
    mutationFn: (body: { expense_entry_id: number; purchase_key: string }) =>
      api.linkRealEstateExpense(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["realEstateLinkCandidates"] });
    },
  });
}

export function useUnmatchRealEstateExpenseMutation() {
  const queryClient = useQueryClient();
  const queryKey = queryKeys.flowsRealEstateExpenses();
  return useMutation({
    mutationFn: (expenseEntryId: number) => api.unmatchRealEstateExpense(expenseEntryId),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["realEstateLinkCandidates"] });
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
      void queryClient.invalidateQueries({ queryKey: queryKeys.income() });
    },
  });
}

export function usePatchIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: {
      movement_id: number;
      income_kind?: import("../types").IncomeKind;
      excluded?: boolean;
      force_include?: boolean;
      note?: string | null;
    }) => {
      const { movement_id, ...body } = vars;
      return api.patchIncomeMovement(movement_id, body);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.income() });
    },
  });
}

export function useForceIncludeIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (movement_id: number) => api.forceIncludeIncomeMovement(movement_id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.income() });
    },
  });
}

export function useRestoreIncomeMovementMutation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (movement_id: number) => api.restoreIncomeMovement(movement_id),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.income() });
    },
  });
}
