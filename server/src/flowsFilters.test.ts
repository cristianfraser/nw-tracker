import { describe, expect, it } from "vitest";
import { applyFlowFilters, type FlowsApiRow } from "./flowsApi.js";

function row(overrides: Partial<FlowsApiRow>): FlowsApiRow {
  return {
    id: 1,
    amount_clp: 0,
    occurred_on: "2026-01-01",
    note: null,
    units_delta: null,
    flow_kind: null,
    amount_usd: null,
    ticker: null,
    flow_type: "deposit",
    flow_type_label: "Depósito CLP",
    counterpart_account_id: null,
    counterpart_account_name: null,
    transfer_direction: null,
    key: "1:movement:1",
    account_id: 1,
    account_name: "Cuenta A",
    category_slug: "generic",
    ...overrides,
  } as FlowsApiRow;
}

const ROWS: FlowsApiRow[] = [
  row({ id: 1, occurred_on: "2026-05-01", amount_clp: 111_003, note: "PANADERIA SAN CAMILO" }),
  row({ id: 2, occurred_on: "2026-05-15", amount_clp: -222_007, note: "FARMACIA" }),
  row({
    id: 3,
    occurred_on: "2026-06-01",
    amount_clp: 333_009,
    note: "sueldo",
    account_id: 2,
    account_name: "Cuenta Beta",
  }),
  row({
    id: 4,
    occurred_on: "2026-06-10",
    amount_clp: 444_011,
    note: "traspaso",
    counterpart_account_name: "Cuenta Beta",
    transfer_direction: "in",
  }),
];

describe("applyFlowFilters (shared by group/account/dashboard flows tables)", () => {
  it("q matches note, account name, and counterpart name", () => {
    expect(applyFlowFilters(ROWS, { q: "panaderia san" })).toHaveLength(1);
    // "beta" hits row 3 (account) and row 4 (counterpart)
    expect(applyFlowFilters(ROWS, { q: "beta" }).map((r) => r.id)).toEqual([3, 4]);
  });

  it("applies inclusive date bounds", () => {
    const out = applyFlowFilters(ROWS, { date_from: "2026-05-15", date_to: "2026-06-01" });
    expect(out.map((r) => r.id)).toEqual([2, 3]);
  });

  it("amount_exact matches rounded |amount|; min/max bound it", () => {
    expect(applyFlowFilters(ROWS, { amount_exact: 222_007 }).map((r) => r.id)).toEqual([2]);
    expect(
      applyFlowFilters(ROWS, { amount_min: 200_000, amount_max: 400_000 }).map((r) => r.id)
    ).toEqual([2, 3]);
  });

  it("filters by account_id", () => {
    expect(applyFlowFilters(ROWS, { account_id: 2 }).map((r) => r.id)).toEqual([3]);
  });
});
