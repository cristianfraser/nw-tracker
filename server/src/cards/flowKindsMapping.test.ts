import { describe, expect, it } from "vitest";
import {
  CARD_LINE_KINDS,
  FLOW_KIND_CLASSES,
  FLOW_KINDS,
  flowKindClass,
  LEGACY_FLOW_KIND_MAP,
  type FlowKindId,
} from "nw-tracker-contracts";
import type { IncomeKind } from "nw-tracker-contracts/dto";
import type { MovementFlowType, MortgageFlowKind } from "../movementFlowType.js";
import type { DepositFlowKind } from "../depositFlowKind.js";
import { BROKERAGE_FLOW_KINDS, type BrokerageFlowKind } from "../brokerageFlowMovement.js";
import { CRYPTO_MOVEMENT_KINDS, type CryptoMovementKind } from "../cryptoMovementKinds.js";
import { CHECKING_INCOME_KINDS, type CheckingIncomeKind } from "../flowsCheckingIncomeOverrides.js";
import type { CcExpenseLineRole } from "../ccExpensePeriodMonth.js";

// Each table typed against its taxonomy: a member without a kind (or a key that is not a member)
// fails to compile.
const movement: Record<MovementFlowType, FlowKindId> = LEGACY_FLOW_KIND_MAP.MovementFlowType;
const deposit: Record<DepositFlowKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.DepositFlowKind;
const brokerage: Record<BrokerageFlowKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.BrokerageFlowKind;
const mortgage: Record<MortgageFlowKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.MortgageFlowKind;
const crypto: Record<CryptoMovementKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.CryptoMovementKind;
const income: Record<IncomeKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.IncomeKind;
const checkingIncome: Record<CheckingIncomeKind, FlowKindId> = LEGACY_FLOW_KIND_MAP.CheckingIncomeKind;
const lineRole: Record<CcExpenseLineRole, FlowKindId> = LEGACY_FLOW_KIND_MAP.CcExpenseLineRole;

describe("flow kinds", () => {
  it("every kind has a known class and a unique id", () => {
    const ids = FLOW_KINDS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const k of FLOW_KINDS) expect(FLOW_KIND_CLASSES).toContain(k.class);
    for (const k of CARD_LINE_KINDS) expect(ids).toContain(k);
  });

  it("every member of the runtime taxonomies maps onto a kind", () => {
    for (const m of BROKERAGE_FLOW_KINDS) expect(flowKindClass(brokerage[m])).toBeTruthy();
    for (const m of CRYPTO_MOVEMENT_KINDS) expect(flowKindClass(crypto[m])).toBeTruthy();
    for (const m of CHECKING_INCOME_KINDS) expect(flowKindClass(checkingIncome[m])).toBeTruthy();
    for (const table of [movement, deposit, mortgage, income, lineRole]) {
      for (const kind of Object.values(table)) expect(flowKindClass(kind)).toBeTruthy();
    }
  });

  it("taxonomies that share a member agree on its kind", () => {
    for (const [m, k] of Object.entries(deposit)) expect(movement[m as MovementFlowType]).toBe(k);
    for (const [m, k] of Object.entries(brokerage)) expect(movement[m as MovementFlowType]).toBe(k);
    for (const [m, k] of Object.entries(mortgage)) expect(movement[m as MovementFlowType]).toBe(k);
    expect(checkingIncome).toEqual(income);
  });

  it("spending with no card line has kinds of its own", () => {
    expect(flowKindClass("purchase")).toBe("spending");
    expect(flowKindClass("refund")).toBe("spending");
    expect(CARD_LINE_KINDS as readonly string[]).not.toContain("purchase");
  });

  it("an unknown kind throws", () => {
    expect(() => flowKindClass("shopping")).toThrow(/Unknown flow kind/);
  });
});
