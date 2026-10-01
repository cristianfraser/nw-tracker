import { describe, expect, it } from "vitest";
import { pairStatementLines } from "./cardStatementCrossCheck.js";

describe("pairStatementLines", () => {
  it("pairs exact merchant+amount first, then a leftover by amount and merchant prefix", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "MERPAGO*CABIFY", amount: 9851, kind: "purchase" },
        // The bank's short name; the PDF layout stored it with the glued charge-type column.
        { merchant: "SEG AUTO SANTANDER", amount: 29408, kind: "charge" },
      ],
      [
        { merchant: "MERPAGO*CABIFY", amount: 9851 },
        { merchant: "SEG AUTO SANTANDER COMPRAS P.A.T.", amount: 29408 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.matched_by_prefix).toBe(1);
    expect(pairing.only_in_json).toEqual([]);
    expect(pairing.only_in_db).toEqual([]);
  });

  it("never pairs by prefix across a different amount or a longer word", () => {
    const pairing = pairStatementLines(
      [{ merchant: "SEG", amount: 29408, kind: "charge" }],
      [
        { merchant: "SEGURO HOGAR", amount: 29408 }, // «SEG» is not a whole-word prefix of «SEGURO»
        { merchant: "SEG AUTO SANTANDER COMPRAS P.A.T.", amount: 29409 }, // amount differs
      ]
    );
    expect(pairing.matched).toBe(0);
    expect(pairing.only_in_json).toHaveLength(1);
    expect(pairing.only_in_db).toHaveLength(2);
  });

  it("pairs a merchant that differs only in rendering: terminal code, punctuation", () => {
    const pairing = pairStatementLines(
      [
        // The JSON keeps the acquirer's terminal code the PDF parse drops…
        { merchant: "VITEST KIOSCO 1234", amount: 12.5, kind: "purchase" },
        // …and prints «]» where the PDF prints «!».
        { merchant: "VITEST ABC] 12 CENTRO", amount: 1500, kind: "purchase" },
      ],
      [
        { merchant: "VITEST KIOSCO", amount: 12.5 },
        { merchant: "VITEST ABC! 12 CENTRO", amount: 1500 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.matched_by_prefix).toBe(0);
    expect(pairing.matched_by_rendering).toBe(2);
    expect(pairing.only_in_json).toEqual([]);
    expect(pairing.only_in_db).toEqual([]);
  });

  it("never pairs by rendering across a different amount or different letters", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "VITEST KIOSCO 1234", amount: 12.5, kind: "purchase" },
        { merchant: "VITEST KIOSCOS", amount: 20, kind: "purchase" },
      ],
      [
        { merchant: "VITEST KIOSCO", amount: 12.51 }, // amount differs
        { merchant: "VITEST KIOSCO", amount: 20 }, // «KIOSCOS» is another name
      ]
    );
    expect(pairing.matched).toBe(0);
    expect(pairing.only_in_json).toHaveLength(2);
    expect(pairing.only_in_db).toHaveLength(2);
  });

  it("stays one-to-one: two identical JSON rows consume two ledger lines, a third is reported", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "APPLE.COM/BILL", amount: 1390, kind: "purchase" },
        { merchant: "APPLE.COM/BILL", amount: 1390, kind: "purchase" },
        { merchant: "APPLE.COM/BILL", amount: 1390, kind: "purchase" },
      ],
      [
        { merchant: "APPLE.COM/BILL", amount: 1390 },
        { merchant: "APPLE.COM/BILL", amount: 1390 },
      ]
    );
    expect(pairing.matched).toBe(2);
    expect(pairing.only_in_json).toHaveLength(1);
    expect(pairing.only_in_db).toEqual([]);
  });
});
