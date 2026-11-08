import { describe, expect, it } from "vitest";
import { sumLineAmountsClp } from "./ccExpenseLineBuckets";
import type { FlowCcExpenseLineRow } from "./types";

describe("ccExpenseLineBuckets", () => {
  it("sums the lines' pesos", () => {
    const rows = [{ amount_clp: 1000 }, { amount_clp: 2000 }, { amount_clp: -300 }] as FlowCcExpenseLineRow[];
    expect(sumLineAmountsClp(rows)).toBe(2700);
  });
});
