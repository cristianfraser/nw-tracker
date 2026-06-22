import type { BrokerageFlowKind } from "./brokerageFlowKinds";
import { type InitialMovementDraft, parseOptionalNumber } from "./stockAccountFormTypes";

export type UsdCashAccountFormDraft = {
  displayName: string;
  bucketSlug: string;
  excludeFromGroupTotals: boolean;
  initialMovements: InitialMovementDraft[];
};

export function defaultUsdCashAccountFormDraft(bucketSlug = "cash_savings"): UsdCashAccountFormDraft {
  return {
    displayName: "USD",
    bucketSlug,
    excludeFromGroupTotals: false,
    initialMovements: [],
  };
}

export type UsdCashAccountCreatePreview = {
  account: {
    kind: "usd_cash";
    name: string;
    category_slug: string;
    bucket_slug: string;
    exclude_from_group_totals: boolean;
  };
  initial_movements: {
    occurred_on: string;
    flow_kind: BrokerageFlowKind;
    amount_clp: number | null;
    amount_usd: number | null;
    units_delta: number | null;
    counterpart_account_id?: number;
    counterpart_role?: "to" | "from";
  }[];
};

export function buildUsdCashMovementPostBody(
  row: InitialMovementDraft
): Record<string, unknown> | null {
  const occurred_on = row.occurredOn.trim();
  if (!occurred_on) return null;
  return {
    occurred_on,
    flow_kind: row.flowKind,
    amount_clp: parseOptionalNumber(row.amountClp),
    amount_usd: parseOptionalNumber(row.amountUsd),
    ...(row.counterpartAccountId !== ""
      ? { counterpart_account_id: row.counterpartAccountId, counterpart_role: "to" as const }
      : {}),
  };
}

export function buildUsdCashAccountCreatePreview(
  draft: UsdCashAccountFormDraft
): UsdCashAccountCreatePreview | null {
  const name = draft.displayName.trim();
  if (!name || draft.bucketSlug !== "cash_savings") return null;
  const categorySlug = "usd";

  const movements = draft.initialMovements
    .map((row) => {
      const body = buildUsdCashMovementPostBody(row);
      if (!body) return null;
      return {
        occurred_on: body.occurred_on as string,
        flow_kind: body.flow_kind as BrokerageFlowKind,
        amount_clp: body.amount_clp as number | null,
        amount_usd: body.amount_usd as number | null,
        units_delta: null,
        ...(body.counterpart_account_id != null
          ? {
              counterpart_account_id: body.counterpart_account_id as number,
              counterpart_role: body.counterpart_role as "to",
            }
          : {}),
      };
    })
    .filter((m): m is NonNullable<typeof m> => m != null);

  return {
    account: {
      kind: "usd_cash",
      name,
      category_slug: categorySlug,
      bucket_slug: draft.bucketSlug,
      exclude_from_group_totals: draft.excludeFromGroupTotals,
    },
    initial_movements: movements,
  };
}
