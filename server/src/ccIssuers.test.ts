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
import { closedBillingMonthsFromStatements } from "./cards/facturacion.js";
import type { CcStatementRow } from "./ccStatementsDb.js";

function stmt(billingMonth: string, currency: string, close: string, kind = "statement_pdf"): CcStatementRow {
  return { billing_month: billingMonth, currency, period_to: close, statement_date: close, source_kind: kind } as unknown as CcStatementRow;
}

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

  it("every issuer states its statement currencies, cuota products and listing", () => {
    for (const i of CC_ISSUERS) {
      expect(i.statement_currencies.primary).toMatch(/^[a-z]{3}$/);
      expect(i.statement_currencies.secondary).not.toContain(i.statement_currencies.primary);
    }
  });

  describe("the close rule reads the issuer's primary currency", () => {
    it("a primary-only issuer closes on its one statement", () => {
      const closed = closedBillingMonthsFromStatements([stmt("2026-01", "usd", "2026-01-20")], "usd", new Set(["usd"]), null);
      expect([...closed]).toEqual(["2026-01"]);
    });
    it("a month with only a secondary statement never closes", () => {
      expect(closedBillingMonthsFromStatements([stmt("2026-01", "usd", "2026-01-20")], "clp", new Set(["clp", "usd"]), "2026-03-01").size).toBe(0);
    });
    it("waits for a required secondary until a later bank close proves it is not coming", () => {
      const rows = [stmt("2026-01", "clp", "2026-01-20")];
      const required = new Set(["clp", "usd"]);
      expect(closedBillingMonthsFromStatements(rows, "clp", required, null).size).toBe(0);
      expect(closedBillingMonthsFromStatements(rows, "clp", required, "2026-01-20").size).toBe(0);
      expect([...closedBillingMonthsFromStatements(rows, "clp", required, "2026-02-20")]).toEqual(["2026-01"]);
      expect([...closedBillingMonthsFromStatements([...rows, stmt("2026-01", "usd", "2026-01-20")], "clp", required, null)]).toEqual(["2026-01"]);
    });
    it("a web-paste listing closes nothing", () => {
      expect(closedBillingMonthsFromStatements([stmt("2026-01", "usd", "2026-01-20", "listing_open")], "usd", new Set(["usd"]), null).size).toBe(0);
    });
  });
});
