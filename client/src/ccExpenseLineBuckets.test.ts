import { clpMoney } from "./test/lineMoneyFixture";
import { describe, expect, it } from "vitest";
import { sumLineAmountsClp } from "./ccExpenseLineBuckets";
import type { FlowCcExpenseLineRow } from "./types";

describe("ccExpenseLineBuckets", () => {
  it("sums the lines' pesos", () => {
    const rows = [{ ...clpMoney(1000) }, { ...clpMoney(2000) }, { ...clpMoney(-300) }] as FlowCcExpenseLineRow[];
    expect(sumLineAmountsClp(rows)).toBe(2700);
  });
});
