import { describe, expect, it } from "vitest";
import { db } from "./db.js";
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

  it("assigns and loads purchase big group", () => {
    const group = createCcExpenseBigGroup(`Vitest trip ${Date.now()}`);
    const accountId = (
      db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 1`).get() as { id: number } | undefined
    )?.id;
    expect(accountId).toBeTruthy();
    setCcExpensePurchaseBigGroup({
      accountId: accountId!,
      purchaseKey: "line-pr:vitest-big-group",
      groupSlug: group.slug,
    });
    const map = loadCcExpensePurchaseBigGroups([accountId!]);
    expect(map.get(`${accountId}|line-pr:vitest-big-group`)).toBe(group.slug);
    setCcExpensePurchaseBigGroup({
      accountId: accountId!,
      purchaseKey: "line-pr:vitest-big-group",
      groupSlug: null,
    });
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
