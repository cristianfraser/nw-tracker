import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccOneShotDedupeKey } from "./ccDedupeKey.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import {
  ccWebPasteToCsvRecords,
  creditCardMasterMetaForAccount,
  isCcCuotaBillingReferenceMerchant,
  parseCcWebPasteText,
} from "./ccWebPasteParse.js";

const SAMPLE = `20/05/2026 		ARAMCO 	-$1.990 		
19/05/2026 		JUMBO COSTANERA CENTER 	-$32.399 		
		MP*MICOCACOLA 	-$46.360 		
07/05/2026 		PAGO 		+$5.570.527`;

const BCI_SAMPLE = `11/06/2026\tTOKU *METLIFE HIPOTE\t\t$1.795.575
11/06/2026\tENTEL HOGAR\t\t$21.249`;

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
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    expect(openBm).toBeTruthy();
    const { records } = ccWebPasteToCsvRecords(master.id, "santander", "4242", "test", lines);
    expect(records[0]?.source_pdf).toBe(openWebPasteSourcePdf(openBm!));
    expect(records[0]?.statement_date).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("dedupe keys match one-shot PDF formula for charges", () => {
    const { lines } = parseCcWebPasteText("19/05/2026\tSHOP\t-$10.000");
    const line = lines[0]!;
    const key = ccOneShotDedupeKey("santander", line.merchant, Math.abs(line.amount_clp), line.transaction_date);
    expect(key).toHaveLength(16);
  });

  it("stores charges positive and payments negative in CSV records", () => {
    const { lines } = parseCcWebPasteText(SAMPLE);
    const { records } = ccWebPasteToCsvRecords(0, "santander", "4242", "test", lines);
    const charge = records.find((r) => r.merchant === "ARAMCO");
    const pago = records.find((r) => r.merchant === "PAGO");
    expect(charge?.amount_clp).toBe("1990");
    expect(pago?.amount_clp).toBe("-5570527");
  });

  it("parses BCI-style positive charge amounts", () => {
    const { lines, errors } = parseCcWebPasteText(BCI_SAMPLE);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      transaction_date: "2026-06-11",
      merchant: "TOKU *METLIFE HIPOTE",
      amount_clp: 1795575,
    });
    expect(lines[1]).toMatchObject({
      transaction_date: "2026-06-11",
      merchant: "ENTEL HOGAR",
      amount_clp: 21249,
    });
  });

  it("parses USD charges into amount_usd with Chilean decimals and preserved sign", () => {
    const { lines, errors } = parseCcWebPasteText(
      "30/06/2026\tANTHROPIC* CLAU\t-USD99,28\n25/06/2026\tAPPLE.COM/BILL\t-US$1.234,50"
    );
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ merchant: "ANTHROPIC* CLAU", currency: "usd", amount_usd: -99.28, amount_clp: 0 });
    expect(lines[1]).toMatchObject({ merchant: "APPLE.COM/BILL", currency: "usd", amount_usd: -1234.5, amount_clp: 0 });
  });

  it("emits USD charges as amount_usd (charge positive) with amount_clp empty and orig_currency usd", () => {
    const { lines } = parseCcWebPasteText("30/06/2026\tANTHROPIC* CLAU\t-USD99,28");
    const { records } = ccWebPasteToCsvRecords(0, "santander", "4242", "test", lines);
    const r = records.find((x) => x.merchant === "ANTHROPIC* CLAU");
    expect(r?.amount_clp).toBe(""); // no bogus CLP value
    expect(r?.amount_usd).toBe("99.28"); // Santander charge → positive
    expect(r?.orig_currency).toBe("usd");
  });

  it("maps BCI master to BCI card_group", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|bci|4343'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    expect(creditCardMasterMetaForAccount(master.id)).toEqual({
      cardGroup: "BCI",
      cardLast4: "4343",
    });
  });

  it("assigns BCI pasted lines to open bucket with BCI card_group", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|bci|4343'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const meta = creditCardMasterMetaForAccount(master.id);
    const { lines } = parseCcWebPasteText("11/06/2026\tENTEL HOGAR\t$21.249");
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    expect(openBm).toBeTruthy();
    const { records } = ccWebPasteToCsvRecords(
      master.id,
      meta.cardGroup,
      meta.cardLast4,
      "test",
      lines
    );
    expect(records[0]?.card_group).toBe("BCI");
    expect(records[0]?.card_last4).toBe("4343");
    expect(records[0]?.amount_clp).toBe("21249");
    expect(records[0]?.source_pdf).toBe(openWebPasteSourcePdf(openBm!));
  });
});

describe("creditCardMasterMetaForAccount", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function makeAccount(opts: { importKey: string; notes: string | null; cardLast4: string | null }): number {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · master meta', ?, ?)`)
        .run(bucket.id, opts.notes, opts.importKey).lastInsertRowid
    );
    created.push(id);
    if (opts.cardLast4 != null) {
      db.prepare(`INSERT INTO credit_card_account_config (account_id, card_last4) VALUES (?, ?)`).run(
        id,
        opts.cardLast4
      );
    }
    return id;
  }

  it("reads the issuer from import_key and the last4 from the config row, never notes", () => {
    const id = makeAccount({
      importKey: "credit_card_master|bci|vitest-meta-structured",
      notes: "credit_card_master|santander|1111",
      cardLast4: "9933",
    });
    expect(creditCardMasterMetaForAccount(id)).toEqual({ cardGroup: "BCI", cardLast4: "9933" });
  });

  it("throws for an account whose import_key is not a credit card master, whatever its notes say", () => {
    const id = makeAccount({
      importKey: "vitest-meta-not-a-master",
      notes: "credit_card_master|santander|9934",
      cardLast4: "9934",
    });
    expect(() => creditCardMasterMetaForAccount(id)).toThrow(/is not a credit card master/);
  });

  it("throws for a master without a config last4", () => {
    const id = makeAccount({
      importKey: "credit_card_master|santander|vitest-meta-no-config",
      notes: null,
      cardLast4: null,
    });
    expect(() => creditCardMasterMetaForAccount(id)).toThrow(/credit_card_account_config\.card_last4/);
  });

  it("throws for an issuer with no web-paste card group", () => {
    const id = makeAccount({
      importKey: "credit_card_master|vitestbank|vitest-meta-issuer",
      notes: null,
      cardLast4: "9935",
    });
    expect(() => creditCardMasterMetaForAccount(id)).toThrow(/issuer "vitestbank"/);
  });
});

describe("isCcCuotaBillingReferenceMerchant", () => {
  it("matches the feed's cuota-billing reference rendering", () => {
    expect(isCcCuotaBillingReferenceMerchant("CUOT: 000000009OPER: 000032")).toBe(true);
    expect(isCcCuotaBillingReferenceMerchant("CUOT: 000000001OPER: 000054")).toBe(true);
    // Spacing variants and lowercase survive normalization differences between paths.
    expect(isCcCuotaBillingReferenceMerchant("CUOT:000000002 OPER: 000043")).toBe(true);
    expect(isCcCuotaBillingReferenceMerchant("cuot: 000000002oper: 000043")).toBe(true);
  });

  it("matches the manual paste's 15-char truncation (OPER half cut off)", () => {
    expect(isCcCuotaBillingReferenceMerchant("CUOT: 000000009")).toBe(true);
  });

  it("never matches real merchants or cuota-type descriptions", () => {
    expect(isCcCuotaBillingReferenceMerchant("TRES CUOTAS CONTADO")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant("CUOTAS COMERCIO")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant("8 BITS TRES CUOTAS PREC")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant("MERCADO PAGO 4 TCOM")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant("CUOTAS: RESTAURANT")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant("")).toBe(false);
    expect(isCcCuotaBillingReferenceMerchant(null)).toBe(false);
  });
});

describe("cuota-billing rows in ccWebPasteToCsvRecords", () => {
  it("routes CUOT reference rows to skipped_cuota_billing, keeps real purchases", () => {
    const { lines } = parseCcWebPasteText(
      [
        "25/08/2026\tCUOT: 000000009OPER: 000032\t-$139.583",
        "25/08/2026\tCUOT: 000000001OPER: 000053\t-$400.000",
        "25/08/2026\tJUMBO COSTANERA CENTER\t-$32.399",
      ].join("\n")
    );
    expect(lines).toHaveLength(3);
    const { records, skipped_cuota_billing } = ccWebPasteToCsvRecords(
      0,
      "santander",
      "4242",
      "test",
      lines
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.merchant).toBe("JUMBO COSTANERA CENTER");
    expect(skipped_cuota_billing).toHaveLength(2);
    expect(skipped_cuota_billing.map((f) => f.description)).toEqual([
      "CUOT: 000000009OPER: 000032",
      "CUOT: 000000001OPER: 000053",
    ]);
    expect(skipped_cuota_billing[0]?.amount_clp).toBe(139583);
  });
});
