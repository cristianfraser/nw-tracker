import { describe, expect, it } from "vitest";
import { shownNameFields, wireLineBankText } from "./expenseShownName.js";

describe("the one name a row shows", () => {
  it("is the bank's text with nothing behind it when no other name was derived", () => {
    expect(shownNameFields({ merchant: "JUMBO LA REINA" }, "t")).toEqual({ name: { kind: "text", text: "JUMBO LA REINA" } });
  });

  it("is the display name, the bank's text and processor kept for the ⓘ card", () => {
    expect(
      shownNameFields({ merchant: "MERPAGO*SHOP X", display_merchant: "Shop X", merchant_processor: "Mercado Pago" }, "t")
    ).toEqual({
      name: { kind: "text", text: "Shop X" },
      name_detail: { bank_text: "MERPAGO*SHOP X", processor: "Mercado Pago" },
    });
  });

  it("is a card payment's name over the display name, which the ⓘ card keeps as the store", () => {
    const paid = { kind: "pays_card", card_brand: "Lider", card_last4: "0101" } as const;
    expect(shownNameFields({ merchant: "RECAUDACION LIDER", display_merchant: "Lider", payment_name: paid }, "t")).toEqual({
      name: paid,
      name_detail: { bank_text: "RECAUDACION LIDER", store_name: "Lider" },
    });
  });

  it("is a refund under its purchase's own name", () => {
    const fields = shownNameFields({ merchant: "NOTA DE CREDITO" }, "t", { merchant: "APPLE.COM CL", display_merchant: "Apple" });
    expect(fields.name).toEqual({ kind: "refund_of", purchase: { kind: "text", text: "Apple" } });
    expect(fields.name_detail).toEqual({ bank_text: "NOTA DE CREDITO" });
    expect(wireLineBankText(fields)).toBe("NOTA DE CREDITO");
  });

  it("throws for a line with no name at all", () => {
    expect(() => shownNameFields({ merchant: "  " }, "line x")).toThrow(/line x has no name/);
  });
});
