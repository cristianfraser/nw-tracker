import { describe, expect, it } from "vitest";
import { cardPastedListingSchema } from "nw-tracker-contracts";
import { parseCardWebPaste, parseWebPasteText } from "./webPaste.js";

const SANTANDER = `20/05/2026 		ARAMCO 	-$1.990 		
19/05/2026 		JUMBO COSTANERA CENTER 	-$32.399 		
		MP*MICOCACOLA 	-$46.360 		
07/05/2026 		PAGO 		+$5.570.527`;

const BCI = `11/06/2026\tTOKU *METLIFE HIPOTE\t\t$1.795.575
11/06/2026\tENTEL HOGAR\t\t$21.249`;

describe("card web paste", () => {
  it("reads dated rows, and rows under a date that inherit it, signed as printed", () => {
    const { lines, errors } = parseWebPasteText(SANTANDER);
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.date, l.merchant, l.amount, l.currency])).toEqual([
      ["2026-05-20", "ARAMCO", -1990, "clp"],
      ["2026-05-19", "JUMBO COSTANERA CENTER", -32399, "clp"],
      ["2026-05-19", "MP*MICOCACOLA", -46360, "clp"],
      ["2026-05-07", "PAGO", 5570527, "clp"],
    ]);
  });

  it("reads BCI's positive charges", () => {
    const { lines, errors } = parseWebPasteText(BCI);
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.date, l.merchant, l.amount])).toEqual([
      ["2026-06-11", "TOKU *METLIFE HIPOTE", 1795575],
      ["2026-06-11", "ENTEL HOGAR", 21249],
    ]);
  });

  it("reads dollar amounts with Chilean decimals and their sign", () => {
    const { lines, errors } = parseWebPasteText("30/06/2026\tANTHROPIC* CLAU\t-USD99,28\n25/06/2026\tAPPLE.COM/BILL\t-US$1.234,50");
    expect(errors).toEqual([]);
    expect(lines.map((l) => [l.merchant, l.amount, l.currency])).toEqual([
      ["ANTHROPIC* CLAU", -99.28, "usd"],
      ["APPLE.COM/BILL", -1234.5, "usd"],
    ]);
  });

  it("reports a row it cannot read instead of guessing", () => {
    const { lines, errors } = parseWebPasteText("SHOP\t-$100\n19/05/2026\tSHOP\tabc");
    expect(lines).toEqual([]);
    expect(errors).toEqual(["Sin fecha para línea: SHOP\t-$100", "Monto inválido (abc): SHOP"]);
  });

  it("answers the parse request with a card.pasted_listing", () => {
    const result = parseCardWebPaste(Buffer.from(BCI, "utf8"));
    expect(result).toMatchObject({ kind: "card.pasted_listing", schema_version: 1 });
    expect(cardPastedListingSchema.parse(result.payload).lines).toHaveLength(2);
  });
});
