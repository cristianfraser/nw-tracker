import { describe, expect, it } from "vitest";
import { accountChartInactive } from "./accountChartInactive.js";
import { isNavRetiredCcMaster } from "./ccNavRetired.js";
import { getCreditCardGroupNavChildren, listCreditCardGroupMasterAccountIds } from "./creditCardTree.js";
import { getLiabilitiesNavChildren } from "./liabilityTree.js";
import { listLiabilitiesTabAccountRows } from "./liabilityTabAccounts.js";
import { db } from "./db.js";

describe("credit card nav and group tab", () => {
  it("keeps Santander issuer in sidebar when 4242 is active", () => {
    const master4242 = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master4242) return;
    expect(accountChartInactive(master4242.id)).toBe(false);

    const santander = getCreditCardGroupNavChildren("santander");
    expect(santander.length).toBe(1);
    expect(santander[0]!.children.some((c) => c.label.includes("4242"))).toBe(true);
  });

  it("hides nav_retired 4141 from sidebar but keeps it on the CC group tab", () => {
    const master4141 = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4141' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master4141) return;
    if (!isNavRetiredCcMaster(master4141.id)) return;

    const santander = getCreditCardGroupNavChildren("santander");
    expect(santander[0]!.children.some((c) => c.label.includes("4141"))).toBe(false);

    const ccTab = listLiabilitiesTabAccountRows("credit_card");
    expect(ccTab.some((r) => r.name.includes("4141"))).toBe(true);
  });

  it("includes nav_retired 4141 in issuer master ids for totals and charts", () => {
    const master4141 = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4141' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master4141) return;
    if (!isNavRetiredCcMaster(master4141.id)) return;

    expect(listCreditCardGroupMasterAccountIds("santander")).toContain(master4141.id);
  });

  it("includes BCI on the CC group tab even when exclude_from_group_totals is set", () => {
    const bciMaster = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|bci|4343' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!bciMaster) return;

    const ccTab = listLiabilitiesTabAccountRows("credit_card");
    expect(ccTab.some((r) => r.name.toLowerCase().includes("bci"))).toBe(true);
  });

  it("lists santander and bci issuers under tarjeta de crédito in sidebar", () => {
    const liab = getLiabilitiesNavChildren();
    const cc = liab.find((n) => n.slug === "liabilities_credit_card");
    const slugs = cc?.children?.map((c) => c.slug) ?? [];
    expect(slugs).toContain("santander");
    expect(slugs).toContain("bci");
  });
});
