import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccOneShotDedupeKey } from "./ccDedupeKey.js";
import { ccWebPasteToCsvRecords, parseCcWebPasteText } from "./ccWebPasteParse.js";

const SAMPLE = `20/05/2026 		ARAMCO 	-$1.990 		
19/05/2026 		JUMBO COSTANERA CENTER 	-$32.399 		
		MP*MICOCACOLA 	-$46.360 		
07/05/2026 		PAGO 		+$5.570.527`;

describe("parseCcWebPasteText", () => {
  it("parses dated rows and merchants without date on continuation lines", () => {
    const { lines, errors } = parseCcWebPasteText(SAMPLE);
    expect(errors).toEqual([]);
    expect(lines.length).toBe(4);
    expect(lines[0]).toMatchObject({
      transaction_date: "2026-05-20",
      merchant: "ARAMCO",
      amount_clp: -1990,
    });
    expect(lines[1]).toMatchObject({
      transaction_date: "2026-05-19",
      merchant: "JUMBO COSTANERA CENTER",
      amount_clp: -32399,
    });
    expect(lines[2]).toMatchObject({
      transaction_date: "2026-05-19",
      merchant: "MP*MICOCACOLA",
      amount_clp: -46360,
    });
    expect(lines[3]).toMatchObject({
      transaction_date: "2026-05-07",
      merchant: "PAGO",
      amount_clp: 5570527,
    });
  });

  it("assigns pasted lines to open billing month after last PDF", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const { lines } = parseCcWebPasteText("19/05/2026\tSHOP\t-$10.000");
    const records = ccWebPasteToCsvRecords(master.id, "santander", "4242", "test", lines);
    expect(records[0]?.source_pdf).toBe("import:web-paste|open|2026-05");
    expect(records[0]?.statement_date).toBe("20/05/2026");
  });

  it("dedupe keys match one-shot PDF formula for charges", () => {
    const { lines } = parseCcWebPasteText("19/05/2026\tSHOP\t-$10.000");
    const line = lines[0]!;
    const key = ccOneShotDedupeKey("santander", line.merchant, Math.abs(line.amount_clp), line.transaction_date);
    expect(key).toHaveLength(16);
  });

  it("stores charges positive and payments negative in CSV records", () => {
    const { lines } = parseCcWebPasteText(SAMPLE);
    const records = ccWebPasteToCsvRecords(0, "santander", "4242", "test", lines);
    const charge = records.find((r) => r.merchant === "ARAMCO");
    const pago = records.find((r) => r.merchant === "PAGO");
    expect(charge?.amount_clp).toBe("1990");
    expect(pago?.amount_clp).toBe("-5570527");
  });
});
