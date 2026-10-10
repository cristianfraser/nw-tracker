import { describe, expect, it } from "vitest";
import {
  createCcExpenseBigGroup,
  deleteCcExpenseBigGroup,
  listCcExpenseBigGroups,
  loadCcExpensePurchaseBigGroups,
  renameCcExpenseBigGroup,
  setCcExpensePurchaseBigGroup,
  slugFromBigGroupLabel,
} from "./ccExpenseBigGroups.js";

describe("ccExpenseBigGroups", () => {
  it("creates slug from label with dedupe suffix", () => {
    const slug = slugFromBigGroupLabel("Vacaciones NZ 2023");
    expect(slug).toMatch(/^vacaciones_nz_2023/);
  });

  it("keys a big group by the purchase alone, manual expenses included", () => {
    const group = createCcExpenseBigGroup(`Vitest trip ${Date.now()}`);
    for (const purchaseKey of ["line-pr:vitest-big-group", "manual:vitest-big-group"]) {
      setCcExpensePurchaseBigGroup({ purchaseKey, groupSlug: group.slug });
      expect(loadCcExpensePurchaseBigGroups().get(purchaseKey)).toBe(group.slug);
    }
    expect(() =>
      setCcExpensePurchaseBigGroup({ purchaseKey: "payslip:vitest", groupSlug: group.slug })
    ).toThrow(/payroll/);
    for (const purchaseKey of ["line-pr:vitest-big-group", "manual:vitest-big-group"]) {
      setCcExpensePurchaseBigGroup({ purchaseKey, groupSlug: null });
    }
    deleteCcExpenseBigGroup(group.slug);
    expect(listCcExpenseBigGroups().some((g) => g.slug === group.slug)).toBe(false);
  });

  it("renames a big group", () => {
    const group = createCcExpenseBigGroup(`Rename me ${Date.now()}`);
    const renamed = renameCcExpenseBigGroup(group.slug, "Renamed label");
    expect(renamed.label).toBe("Renamed label");
    deleteCcExpenseBigGroup(group.slug);
  });
});
