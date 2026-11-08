import { describe, expect, it } from "vitest";
import {
  CC_ISSUERS,
  ccCardGroupOrDefault,
  ccCardGroupsCompatible,
  ccIssuerForParserLayout,
  ccIssuerForWebPasteCardGroup,
} from "./ccIssuers.js";
import { listingLineStoredAmount, webPasteLinesFromPastedListing } from "./ccWebPasteParse.js";
import { firstCuotaBillingMonth } from "./ccCuotaPurchaseKinds.js";

describe("card issuers as data", () => {
  it("every issuer pastes under its own card group", () => {
    const groups = CC_ISSUERS.map((i) => i.web_paste.card_group.toLowerCase());
    expect(new Set(groups).size).toBe(groups.length);
    for (const i of CC_ISSUERS) expect(ccIssuerForWebPasteCardGroup(i.web_paste.card_group).slug).toBe(i.slug);
    expect(() => ccIssuerForWebPasteCardGroup("A")).toThrow(/No card issuer pastes under/);
  });

  it("a CMR paste is read with its issuer's sign (it used to throw)", () => {
    const { lines } = webPasteLinesFromPastedListing(
      {
        lines: [
          { date: "2021-03-05", merchant: "TIENDA", amount: 12_990, currency: "clp", raw_line: "05/03/2021 TIENDA 12.990" },
          { date: "2021-03-09", merchant: "DEVOLUCION TIENDA", amount: -2_990, currency: "clp", raw_line: "x" },
          { date: "2021-03-20", merchant: "PAGO", amount: 10_000, currency: "clp", raw_line: "y" },
        ],
        errors: [],
      },
      "CMR"
    );
    expect(lines.map(listingLineStoredAmount)).toEqual([12_990, -2_990, -10_000]);
  });

  it("first-cuota timing per issuer and kind", () => {
    expect(firstCuotaBillingMonth("santander", "cuota_comercio", "2026-09")).toBe("2026-10");
    expect(firstCuotaBillingMonth("santander", "precio_contado", "2026-09")).toBe("2026-09");
    expect(firstCuotaBillingMonth("bci", "cuota_comercio", "2026-09")).toBe("2026-09");
  });

  it("parser layouts name their issuer", () => {
    expect(ccIssuerForParserLayout("bci_lider_cargos")?.slug).toBe("bci");
    expect(ccIssuerForParserLayout("compact")).toBeNull();
  });

  it("card groups: the parser default and the paste-group compatibility rule", () => {
    expect(ccCardGroupOrDefault(null)).toBe("A");
    expect(ccCardGroupOrDefault(" B ")).toBe("B");
    expect(ccCardGroupsCompatible("A", "A", "santander")).toBe(true);
    expect(ccCardGroupsCompatible("santander", "INTL", "santander")).toBe(true);
    expect(ccCardGroupsCompatible("B", "A", "santander")).toBe(false);
  });
});
