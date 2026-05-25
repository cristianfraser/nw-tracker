import { describe, expect, it } from "vitest";
import {
  canonicalCcLineDedupeKeys,
  dedupeFlowCcExpenseLines,
  flowCcExpenseLineFingerprint,
} from "./ccExpenseLineDedupe.js";
import type { CcExpenseLineForDedupe } from "./ccExpenseLineDedupe.js";

function line(partial: Partial<CcExpenseLineForDedupe>): CcExpenseLineForDedupe {
  return {
    account_id: 32,
    merchant_key: "LOS BRAVOS SPA",
    amount_clp: 38_830,
    purchase_on: "2025-03-29",
    billing_month: "2025-04",
    installment_flag: 0,
    nro_cuota_current: null,
    nro_cuota_total: null,
    statement_line_id: 1,
    category_slug: "unclassified",
    category_unique: false,
    ...partial,
  };
}

describe("ccExpenseLineDedupe", () => {
  it("canonical keys match across dd/mm/yy and dd/mm/yyyy", () => {
    const keysA = canonicalCcLineDedupeKeys("santander", {
      merchant: "LOS BRAVOS SPA",
      amount_clp: "38830",
      transaction_date: "29/03/25",
      dedupe_key: "legacykey00000001",
      installment_flag: "false",
    });
    const keysB = canonicalCcLineDedupeKeys("santander", {
      merchant: "LOS BRAVOS SPA",
      amount_clp: "38830",
      transaction_date: "29/03/2025",
      dedupe_key: "legacykey00000002",
      installment_flag: "false",
    });
    expect(keysA.some((k) => keysB.includes(k))).toBe(true);
  });

  it("dedupes duplicate display lines keeping categorized row", () => {
    const deduped = dedupeFlowCcExpenseLines([
      line({ statement_line_id: 10, category_slug: "unclassified" }),
      line({ statement_line_id: 20, category_slug: "restaurants" }),
    ]);
    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.statement_line_id).toBe(20);
    expect(deduped[0]?.category_slug).toBe("restaurants");
  });

  it("uses same fingerprint for duplicate re-import rows", () => {
    const a = line({ statement_line_id: 23605 });
    const b = line({ statement_line_id: 23694 });
    expect(flowCcExpenseLineFingerprint(a)).toBe(flowCcExpenseLineFingerprint(b));
  });
});
