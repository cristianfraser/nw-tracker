import { isPersonalCapitalFlowType } from "./depositFlowKind";

export type AccountMovementDto = {
  id: number;
  occurred_on: string;
  amount_clp: number;
  note: string | null;
  units_delta: number | null;
  flow_type: string;
  flow_type_label: string;
  flow_kind?: string | null;
  amount_usd?: number | null;
  ticker?: string | null;
};

/** Single row for the account detail flows table (all rows from `movements`). */
export type AccountFlowRow = {
  key: string;
  flow_type_label: string;
  occurred_on: string;
  amount_clp: number | null;
  amount_usd: number | null;
  ticker: string | null;
  units_delta: number | null;
  note: string | null;
  /** Slug for deposit-personal filter (`flow_type` / `flow_kind`). */
  flow_type: string;
};

export function accountMovementsToFlowRows(movements: AccountMovementDto[]): AccountFlowRow[] {
  const rows: AccountFlowRow[] = movements.map((m) => ({
    key: `movement:${m.id}`,
    flow_type_label: m.flow_type_label,
    occurred_on: m.occurred_on,
    amount_clp: m.amount_clp,
    amount_usd: m.amount_usd ?? null,
    ticker: m.ticker ?? null,
    units_delta: m.units_delta,
    note: m.note,
    flow_type: m.flow_type,
  }));
  return rows.sort((a, b) => {
    const byDate = b.occurred_on.localeCompare(a.occurred_on);
    if (byDate !== 0) return byDate;
    return b.key.localeCompare(a.key);
  });
}

export function filterAccountFlowsPersonalOnly(rows: AccountFlowRow[]): AccountFlowRow[] {
  return rows.filter(
    (r) => isPersonalCapitalFlowType(r.flow_type) && !r.note?.includes("cripto-coin-only-wdw")
  );
}

export function accountFlowsShowTickerColumn(
  rows: readonly Pick<AccountFlowRow, "ticker">[]
): boolean {
  return rows.some((r) => r.ticker != null && String(r.ticker).trim() !== "");
}

export function accountFlowsShowUsdColumn(
  rows: readonly Pick<AccountFlowRow, "amount_usd">[]
): boolean {
  return rows.some((r) => r.amount_usd != null && Number.isFinite(r.amount_usd));
}

export type FlowsTableRow = AccountFlowRow & {
  account_name?: string;
  category_slug?: string;
};

/** Merge child account movements into one flows table (newest first). */
export function consolidateAccountFlowRows(
  byAccount: readonly {
    id: number;
    name: string;
    category_slug: string;
    movements: AccountMovementDto[];
  }[]
): FlowsTableRow[] {
  const rows: FlowsTableRow[] = [];
  for (const acc of byAccount) {
    for (const row of accountMovementsToFlowRows(acc.movements)) {
      rows.push({
        ...row,
        key: `${acc.id}:${row.key}`,
        account_name: acc.name,
        category_slug: acc.category_slug,
      });
    }
  }
  return rows.sort((a, b) => {
    const byDate = b.occurred_on.localeCompare(a.occurred_on);
    if (byDate !== 0) return byDate;
    return b.key.localeCompare(a.key);
  });
}
