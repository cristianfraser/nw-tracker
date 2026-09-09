import { describe, expect, it } from "vitest";
import { pairStatementLines } from "./santanderStatementReport.js";

describe("pairStatementLines", () => {
  it("pairs exact merchant+amount first, then a leftover by amount and merchant prefix", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "MERPAGO*CABIFY", amount: 9851, cod_txs: "001" },
        // The bank's short name; the PDF layout stored it with the glued charge-type column.
        { merchant: "SEG AUTO SANTANDER", amount: 29408, cod_txs: "002" },
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
      [{ merchant: "SEG", amount: 29408, cod_txs: "002" }],
      [
        { merchant: "SEGURO HOGAR", amount: 29408 }, // «SEG» is not a whole-word prefix of «SEGURO»
        { merchant: "SEG AUTO SANTANDER COMPRAS P.A.T.", amount: 29409 }, // amount differs
      ]
    );
    expect(pairing.matched).toBe(0);
    expect(pairing.only_in_json).toHaveLength(1);
    expect(pairing.only_in_db).toHaveLength(2);
  });

  it("stays one-to-one: two identical JSON rows consume two ledger lines, a third is reported", () => {
    const pairing = pairStatementLines(
      [
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
        { merchant: "APPLE.COM/BILL", amount: 1390, cod_txs: "001" },
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
