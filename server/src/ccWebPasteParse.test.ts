import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccOneShotDedupeKey } from "./ccDedupeKey.js";
import { billingMonthForManualLedgerPurchase } from "./ccManualBillingMonth.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import {
  ccWebPasteToCsvRecords,
  creditCardMasterMetaForAccount,
  isCcCuotaBillingReferenceMerchant,
  webPasteLinesFromPastedListing,
} from "./ccWebPasteParse.js";

/** Lines as the ingest service reads a paste (signed as the issuer's table prints them). */
function pasted(rows: [date: string, merchant: string, amount: number, currency?: "clp" | "usd"][]) {
  return webPasteLinesFromPastedListing({
    lines: rows.map(([date, merchant, amount, currency]) => ({
      date,
      merchant,
      amount,
      currency: currency ?? "clp",
      raw_line: `${date}\t${merchant}\t${amount}`,
    })),
    errors: [],
  }).lines;
}

/** A Santander paste: charges negative, the payment positive. */
const SANTANDER_LINES = pasted([
  ["2026-05-20", "ARAMCO", -1990],
  ["2026-05-19", "JUMBO COSTANERA CENTER", -32399],
  ["2026-05-19", "MP*MICOCACOLA", -46360],
  ["2026-05-07", "PAGO", 5570527],
]);

describe("ccWebPasteToCsvRecords", () => {
  it("assigns pasted lines to open billing month after last PDF", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'credit_card_master|santander|4242'`)
      .get() as { id: number } | undefined;
    if (!master) return;
    const lines = pasted([["2026-05-19", "SHOP", -10000]]);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    expect(openBm).toBeTruthy();
    const { records } = ccWebPasteToCsvRecords(master.id, "santander", "4242", "test", lines);
    expect(records[0]?.source_pdf).toBe(openWebPasteSourcePdf(openBm!));
    expect(records[0]?.statement_date).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("dedupe keys match one-shot PDF formula for charges", () => {
    const lines = pasted([["2026-05-19", "SHOP", -10000]]);
    const line = lines[0]!;
    const key = ccOneShotDedupeKey("santander", line.merchant, Math.abs(line.amount_clp), line.transaction_date);
    expect(key).toHaveLength(16);
  });

  it("stores charges positive and payments negative in CSV records", () => {
    const lines = SANTANDER_LINES;
    const { records } = ccWebPasteToCsvRecords(0, "santander", "4242", "test", lines);
    const charge = records.find((r) => r.merchant === "ARAMCO");
    const pago = records.find((r) => r.merchant === "PAGO");
    expect(charge?.amount_clp).toBe("1990");
    expect(pago?.amount_clp).toBe("-5570527");
  });

  it("emits USD charges as amount_usd (charge positive) with amount_clp empty and no origin", () => {
    const lines = pasted([["2026-06-30", "ANTHROPIC* CLAU", -99.28, "usd"]]);
    const { records } = ccWebPasteToCsvRecords(0, "santander", "4242", "test", lines);
    const r = records.find((x) => x.merchant === "ANTHROPIC* CLAU");
    expect(r?.amount_clp).toBe(""); // no bogus CLP value
    expect(r?.amount_usd).toBe("99.28"); // Santander charge → positive
    // The web table prints no origin amount, and the import labels origins itself.
    expect(r?.amount_orig).toBeUndefined();
    expect(r?.orig_currency).toBeUndefined();
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
    const lines = pasted([["2026-06-11", "ENTEL HOGAR", 21249]]);
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
    const lines = pasted([
      ["2026-08-25", "CUOT: 000000009OPER: 000032", -139583],
      ["2026-08-25", "CUOT: 000000001OPER: 000053", -400000],
      ["2026-08-25", "JUMBO COSTANERA CENTER", -32399],
    ]);
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
