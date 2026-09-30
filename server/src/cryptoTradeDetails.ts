/**
 * The exchange's record of each crypto trade (`crypto_trade_details`, migration 197) and what the
 * commission was worth in pesos. A commission is charged in pesos (a quick buy, an old market
 * sell) or in coin (a quick sell, an old market buy); coin is valued at the trade's price, or —
 * on a coin-for-coin swap priced in BTC — at the movement's own peso value per unit.
 */
import { db } from "./db.js";

export type CryptoTradeDetail = {
  movementId: number;
  exchangeTradeId: string;
  units: number;
  price: number;
  priceCurrency: "clp" | "btc";
  feeAmount: number;
  feeCurrency: "clp" | "btc" | "eth";
  createdAt: string;
};

/** The commission in pesos; `movementClp` / `movementUnits` are the ledger row's (for a BTC-priced swap). */
export function cryptoTradeFeeClp(d: CryptoTradeDetail, movementClp: number, movementUnits: number): number {
  if (d.feeCurrency === "clp") return d.feeAmount;
  if (d.priceCurrency === "clp") return d.feeAmount * d.price;
  if (!(movementUnits > 0)) throw new Error(`Crypto trade ${d.exchangeTradeId}: no units to value its fee`);
  return d.feeAmount * (Math.abs(movementClp) / movementUnits);
}

export function loadCryptoTradeDetails(movementIds: readonly number[]): Map<number, CryptoTradeDetail> {
  const get = db.prepare(
    `SELECT movement_id, exchange_trade_id, units, price, price_currency, fee_amount, fee_currency, created_at
       FROM crypto_trade_details WHERE movement_id = ?`
  );
  const out = new Map<number, CryptoTradeDetail>();
  for (const id of movementIds) {
    const r = get.get(id) as
      | {
          movement_id: number;
          exchange_trade_id: string;
          units: number;
          price: number;
          price_currency: "clp" | "btc";
          fee_amount: number;
          fee_currency: "clp" | "btc" | "eth";
          created_at: string;
        }
      | undefined;
    if (!r) continue;
    out.set(id, {
      movementId: r.movement_id,
      exchangeTradeId: r.exchange_trade_id,
      units: r.units,
      price: r.price,
      priceCurrency: r.price_currency,
      feeAmount: r.fee_amount,
      feeCurrency: r.fee_currency,
      createdAt: r.created_at,
    });
  }
  return out;
}
