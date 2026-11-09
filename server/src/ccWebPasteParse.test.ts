import { getVitestSantanderCcMasterAccountId } from "./test/vitestDbSeed.js";
import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { ccOneShotDedupeKey } from "./ccDedupeKey.js";
import { billingMonthForManualLedgerPurchase } from "./cards/facturacion.js";
import { openWebPasteSourcePdf } from "./ccOpenWebPasteRepair.js";
import {
  creditCardMasterMetaForAccount,
  isCcCuotaBillingReferenceMerchant,
  listingStatements,
  webPasteLinesFromPastedListing,
} from "./ccWebPasteParse.js";

/** Lines as the ingest service reads a paste (signed as the issuer's table prints them), under a paste group. */
function pasted(rows: [date: string, merchant: string, amount: number, currency?: "clp" | "usd"][], cardGroup = "santander") {
  return webPasteLinesFromPastedListing({
    lines: rows.map(([date, merchant, amount, currency]) => ({
      date,
      merchant,
      amount,
      currency: currency ?? "clp",
      raw_line: `${date}\t${merchant}\t${amount}`,
    })),
    errors: [],
  }, cardGroup).lines;
}

/** A Santander paste: charges negative, the payment positive. */
const SANTANDER_LINES = pasted([
  ["2026-05-20", "ARAMCO", -1990],
  ["2026-05-19", "JUMBO COSTANERA CENTER", -32399],
  ["2026-05-19", "MP*MICOCACOLA", -46360],
  ["2026-05-07", "PAGO", 5570527],
]);

/** The vitest Santander card master (`test/vitestDbSeed.ts`): the records read its config cycle. */
function fixtureCardId(): number {
  const id = getVitestSantanderCcMasterAccountId();
  if (id == null) throw new Error("vitest card fixture missing");
  return id;
}

describe("listingStatements", () => {
  it("assigns pasted lines to open billing month after last PDF", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|4321'`)
      .get() as { id: number };
    const lines = pasted([["2026-05-19", "SHOP", -10000]]);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    expect(openBm).toBeTruthy();
    const { statements } = listingStatements(master.id, "santander", "4242", lines);
    expect(statements[0]?.document).toBe(openWebPasteSourcePdf(openBm!));
    expect(statements[0]?.close).toMatch(/^\d{1,2}\/\d{1,2}\/\d{4}$/);
  });

  it("dedupe keys match one-shot PDF formula for charges", () => {
    const lines = pasted([["2026-05-19", "SHOP", -10000]]);
    const line = lines[0]!;
    const key = ccOneShotDedupeKey("santander", line.merchant, Math.abs(line.amount), line.transaction_date);
    expect(key).toHaveLength(16);
  });

  it("files charges positive and payments negative, each with its kind and listing key", () => {
    const { statements } = listingStatements(fixtureCardId(), "santander", "4242", SANTANDER_LINES);
    const lines = statements.flatMap((st) => st.lines);
    const charge = lines.find((l) => l.merchant === "ARAMCO")!;
    const pago = lines.find((l) => l.merchant === "PAGO")!;
    expect(charge).toMatchObject({ currency: "clp", amount: 1990, kind: "card_purchase", printed_transaction_date: null });
    expect(charge.document.line_id).toBe(`web:${charge.document.dedupe_key}`);
    expect(pago).toMatchObject({ amount: -5570527, kind: "card_payment" });
  });

  it("files USD charges in dollars (charge positive) with no origin", () => {
    const lines = pasted([["2026-06-30", "ANTHROPIC* CLAU", -99.28, "usd"]]);
    const { statements } = listingStatements(fixtureCardId(), "santander", "4242", lines);
    const l = statements[0]!.lines.find((x) => x.merchant === "ANTHROPIC* CLAU")!;
    expect(statements[0]!.currency).toBe("clp"); // the peso bucket carries the dollar line
    expect(l.currency).toBe("usd");
    expect(l.amount).toBe(99.28); // Santander charge → positive
    // The web table prints no origin amount, and the import labels origins itself.
    expect(l.origin_amount).toBeNull();
  });

  it("maps BCI master to BCI card_group", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|bci|6605'`)
      .get() as { id: number };
    expect(creditCardMasterMetaForAccount(master.id)).toEqual({
      cardGroup: "BCI",
      cardLast4: "6605",
    });
  });

  it("assigns BCI pasted lines to open bucket with BCI card_group", () => {
    const master = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|bci|6605'`)
      .get() as { id: number };
    const meta = creditCardMasterMetaForAccount(master.id);
    const lines = pasted([["2026-06-11", "ENTEL HOGAR", 21249]], meta.cardGroup);
    const openBm = billingMonthForManualLedgerPurchase(master.id);
    expect(openBm).toBeTruthy();
    const { statements } = listingStatements(master.id, meta.cardGroup, meta.cardLast4, lines);
    expect(statements[0]?.card_group).toBe("BCI");
    expect(statements[0]?.card_last4).toBe("6605");
    expect(statements[0]?.lines[0]?.amount).toBe(21249);
    expect(statements[0]?.document).toBe(openWebPasteSourcePdf(openBm!));
  });
});

describe("creditCardMasterMetaForAccount", () => {
  const created: number[] = [];
  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  function makeAccount(opts: {
    importKey: string;
    notes: string | null;
    config: { issuer: string | null; cardLast4: string | null } | null;
  }): number {
    const bucket = db
      .prepare(`SELECT id FROM asset_groups WHERE slug IN ('credit_card', 'credit_cards__credit_card') LIMIT 1`)
      .get() as { id: number };
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, 'Vitest · master meta', ?, ?)`)
        .run(bucket.id, opts.notes, opts.importKey).lastInsertRowid
    );
    created.push(id);
    if (opts.config) {
      db.prepare(`INSERT INTO credit_card_account_config (account_id, card_last4, issuer) VALUES (?, ?, ?)`).run(
        id,
        opts.config.cardLast4,
        opts.config.issuer
      );
    }
    return id;
  }

  it("reads the issuer and the last4 from the config row, never the import_key or notes", () => {
    const id = makeAccount({
      importKey: "credit_card_master|santander|vitest-meta-structured",
      notes: "credit_card_master|santander|1111",
      config: { issuer: "bci", cardLast4: "9933" },
    });
    expect(creditCardMasterMetaForAccount(id)).toEqual({ cardGroup: "BCI", cardLast4: "9933" });
  });

  it("throws for an account without a card config row, whatever its import_key says", () => {
    const id = makeAccount({
      importKey: "credit_card_master|santander|vitest-meta-no-config",
      notes: null,
      config: null,
    });
    expect(() => creditCardMasterMetaForAccount(id)).toThrow(/is not a card master/);
  });

  it("throws for a master without a config last4", () => {
    const id = makeAccount({
      importKey: "credit_card_master|santander|vitest-meta-no-last4",
      notes: null,
      config: { issuer: "santander", cardLast4: null },
    });
    expect(() => creditCardMasterMetaForAccount(id)).toThrow(/credit_card_account_config\.card_last4/);
  });

  it("reads a CMR card's paste group from its issuer (bug 7), and throws for an unknown issuer", () => {
    const cmr = makeAccount({
      importKey: "credit_card_master|cmr|vitest-meta-issuer",
      notes: null,
      config: { issuer: "cmr", cardLast4: "9935" },
    });
    expect(creditCardMasterMetaForAccount(cmr)).toEqual({ cardGroup: "CMR", cardLast4: "9935" });
    const unknown = makeAccount({
      importKey: "credit_card_master|vitestbank|vitest-meta-unknown",
      notes: null,
      config: { issuer: "vitestbank", cardLast4: "9936" },
    });
    expect(() => creditCardMasterMetaForAccount(unknown)).toThrow(/unknown card issuer/);
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

describe("cuota-billing rows in listingStatements", () => {
  it("routes CUOT reference rows to skipped_cuota_billing, keeps real purchases", () => {
    const lines = pasted([
      ["2026-08-25", "CUOT: 000000009OPER: 000032", -139583],
      ["2026-08-25", "CUOT: 000000001OPER: 000053", -400000],
      ["2026-08-25", "JUMBO COSTANERA CENTER", -32399],
    ]);
    expect(lines).toHaveLength(3);
    const { statements, skipped_cuota_billing } = listingStatements(fixtureCardId(), "santander", "4242", lines);
    const filed = statements.flatMap((st) => st.lines);
    expect(filed).toHaveLength(1);
    expect(filed[0]?.merchant).toBe("JUMBO COSTANERA CENTER");
    expect(skipped_cuota_billing).toHaveLength(2);
    expect(skipped_cuota_billing.map((f) => f.description)).toEqual([
      "CUOT: 000000009OPER: 000032",
      "CUOT: 000000001OPER: 000053",
    ]);
    expect(skipped_cuota_billing[0]?.amount_clp).toBe(139583);
  });
});
