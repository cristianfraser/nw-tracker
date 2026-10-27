import { describe, expect, it } from "vitest";
import { derivedPayByIso, resolveInstallmentPayByIso } from "./ccInstallmentPayBy.js";
import { CC_ISSUERS, ccIssuerBySlug, ccIssuerSlugFromImportKey } from "./ccIssuers.js";

const santander = ccIssuerBySlug("santander")!.derived_pay_by;
const bci = ccIssuerBySlug("bci")!.derived_pay_by;
const cmr = ccIssuerBySlug("cmr")!.derived_pay_by;

describe("derived pay-by per issuer", () => {
  it("Santander: the 10th of the next month, moved back to the previous Chile business day", () => {
    expect(derivedPayByIso("2026-10-26", santander)).toBe("2026-11-10"); // Tuesday
    expect(derivedPayByIso("2026-09-24", santander)).toBe("2026-10-09"); // 10th is a Saturday
    expect(derivedPayByIso("2026-04-22", santander)).toBe("2026-05-08"); // 10th is a Sunday
    expect(derivedPayByIso("2025-07-23", santander)).toBe("2025-08-08"); // 10th Sunday, 9th Saturday
    expect(derivedPayByIso("2026-05-25", santander)).toBe("2026-06-10"); // Wednesday
  });

  it("Santander: a holiday on the 10th moves it back too", () => {
    // 2026-10-12 is a Monday holiday; with the rule on day 12 the 9th (Friday) would be printed.
    expect(derivedPayByIso("2026-09-24", { kind: "next_month_day", day: 12, prior_business_day: true })).toBe(
      "2026-10-09"
    );
  });

  it("BCI: the 10th as it falls, weekends included", () => {
    expect(derivedPayByIso("2026-09-26", bci)).toBe("2026-10-10"); // Saturday, as printed
    expect(derivedPayByIso("2026-04-26", bci)).toBe("2026-05-10"); // Sunday, as printed
    expect(derivedPayByIso("2025-12-26", bci)).toBe("2026-01-10");
  });

  it("CMR: close + 16 days", () => {
    expect(derivedPayByIso("2019-07-14", cmr)).toBe("2019-07-30");
    expect(derivedPayByIso("2020-02-14", cmr)).toBe("2020-03-01");
  });

  it("accepts the parsers' dd/mm/yyyy close too", () => {
    expect(derivedPayByIso("24/09/2026", santander)).toBe("2026-10-09");
    expect(derivedPayByIso("not a date", santander)).toBeNull();
  });

  it("a printed pay-by wins over the rule; anchors fall back in order", () => {
    expect(resolveInstallmentPayByIso({ pay_by: "09/10/2026", statement_date: "2026-09-24" }, bci)).toBe(
      "2026-10-09"
    );
    expect(resolveInstallmentPayByIso({ period_to: "2026-09-24" }, santander)).toBe("2026-10-09");
    expect(resolveInstallmentPayByIso({ transaction_date: "2026-09-02" }, bci)).toBe("2026-10-10");
    expect(resolveInstallmentPayByIso({}, bci)).toBeNull();
  });
});

describe("issuer from a master's import key", () => {
  it("reads the slug and refuses anything else", () => {
    expect(ccIssuerSlugFromImportKey("credit_card_master|santander|vitest-fixture")).toBe("santander");
    expect(ccIssuerSlugFromImportKey("credit_card_master|bci|1234")).toBe("bci");
    expect(ccIssuerSlugFromImportKey("credit_card_master|unknown|1234")).toBeNull();
    expect(ccIssuerSlugFromImportKey("import:panel|kind=clp|key=clp")).toBeNull();
    expect(ccIssuerSlugFromImportKey(null)).toBeNull();
  });

  it("every issuer carries a derived pay-by rule", () => {
    for (const issuer of CC_ISSUERS) expect(issuer.derived_pay_by.kind).toBeTruthy();
  });
});
