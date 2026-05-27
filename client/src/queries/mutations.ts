import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import type { FlowCcExpenseLineRow, FlowsCreditCardExpensesResponse } from "../types";
import {
  expenseLineMatchesCategoryPatch,
  expenseLineMatchesPurchaseNotePatch,
} from "../ccExpenseLineBuckets";
import { queryKeys, type DisplayUnit } from "./keys";

export type PatchCcExpenseLineCategoryVars = {
  lineId: number;
  unique: boolean;
  category_slug?: string;
  clear_category?: boolean;
};

export function applyCcExpenseLineCategoryPatch(
  data: FlowsCreditCardExpensesResponse | undefined,
  vars: PatchCcExpenseLineCategoryVars
): FlowsCreditCardExpensesResponse | undefined {
  if (!data) return data;
  const anchorLine = data.lines.find(
    (ln) => ln.statement_line_id === vars.lineId
  ) as FlowCcExpenseLineRow | undefined;
  return {
    ...data,
    lines: data.lines.map((ln) => {
      if (!expenseLineMatchesCategoryPatch(ln, vars.lineId, anchorLine)) return ln;
      let category_slug = ln.category_slug;
      if (vars.clear_category) category_slug = "unclassified";
      else if (vars.category_slug) category_slug = vars.category_slug;
      return { ...ln, category_slug, category_unique: vars.unique };
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

export function useCreateCcPurchaseMutation(opts: {
  accountId: number;
  displayUnit: DisplayUnit;
  extraCcOffsetsKey: string;
}) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      purchase_date: string;
      total_amount_clp: number;
      cuotas_totales: number;
      merchant?: string;
      description?: string;
      card_group?: string;
    }) => api.createCcPurchase(opts.accountId, body),
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
