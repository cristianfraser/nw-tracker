/**
 * A crypto coin account's movements as tax-lot events, by their stored kind
 * (`crypto_movement_kinds`). Amounts are pesos: a trade's amount is what the exchange paid or
 * received; a swap's or a send's is the coin's market value that day (the Buda rebuild wrote it).
 *
 * How each kind counts is {@link CRYPTO_KIND_LOT_TREATMENT}, one line per kind so a tax rule can be
 * changed in one place:
 * - `buy` / `swap_in` open a lot at their amount; `round_trip_return` opens one at zero cost
 *   (coin that came back with no purchase on record here — the conservative choice, it can only
 *   overstate a later gain);
 * - `sell` closes at what it received; `swap_out` and `coin_out` close at market value (a coin
 *   exchanged or spent is disposed of at what it was worth); `send_fee` closes at zero (coin lost).
 *
 * Commissions ({@link CryptoFeePolicy}): the SII does not let a persona natural sin contabilidad
 * deduct them (its crypto FAQ, citing Oficio 1474/2020; Oficio 2208/2022 restates that the
 * final-tax bases «no contemplan la deducción de estos gastos»), so under `excluded` — the
 * default — a purchase's cost is what was paid less the
 * commission and a sale's price is what was received plus it, from the exchange's own record
 * (`crypto_trade_details`; a buy, sell or swap_in without one throws). `included` keeps the ledger's
 * pesos (the economic view).
 */
import { db } from "./db.js";
import { loadCryptoMovementKinds, type CryptoMovementKind } from "./cryptoMovementKinds.js";
import { cryptoTradeFeeClp, loadCryptoTradeDetails, type CryptoTradeDetail } from "./cryptoTradeDetails.js";
import type { TaxLotEvent } from "./taxLots.js";

export type CryptoLotTreatment = "acquire_at_amount" | "acquire_at_zero" | "dispose_at_amount" | "dispose_at_zero";

export const CRYPTO_KIND_LOT_TREATMENT: Record<CryptoMovementKind, CryptoLotTreatment> = {
  buy: "acquire_at_amount",
  swap_in: "acquire_at_amount",
  round_trip_return: "acquire_at_zero",
  sell: "dispose_at_amount",
  swap_out: "dispose_at_amount",
  coin_out: "dispose_at_amount",
  send_fee: "dispose_at_zero",
};

export type CryptoTaxLotRow = { id: number; occurred_on: string; amount: number; units_delta: number };

export type CryptoFeePolicy = "excluded" | "included";

/** Kinds that are trades on the exchange, so carry a commission. */
const TRADE_KINDS: ReadonlySet<CryptoMovementKind> = new Set(["buy", "sell", "swap_in"]);

export function cryptoTaxLotEventsFromRows(
  rows: readonly CryptoTaxLotRow[],
  kinds: ReadonlyMap<number, CryptoMovementKind>,
  fees: { policy: CryptoFeePolicy; details: ReadonlyMap<number, CryptoTradeDetail> } = {
    policy: "included",
    details: new Map(),
  }
): TaxLotEvent[] {
  const events: TaxLotEvent[] = rows.map((r) => {
    const kind = kinds.get(r.id);
    if (!kind) throw new Error(`Crypto tax lots: movement ${r.id} has no kind`);
    const treatment = CRYPTO_KIND_LOT_TREATMENT[kind];
    const acquires = treatment === "acquire_at_amount" || treatment === "acquire_at_zero";
    if (acquires !== r.units_delta > 0) {
      throw new Error(`Crypto tax lots: movement ${r.id} (${kind}) moves ${r.units_delta} units`);
    }
    const units = Math.abs(r.units_delta);
    let amount = Math.abs(r.amount);
    if (fees.policy === "excluded" && TRADE_KINDS.has(kind)) {
      const detail = fees.details.get(r.id);
      if (!detail) throw new Error(`Crypto tax lots: trade ${r.id} (${kind}) has no exchange record — run import-buda-trade-details`);
      const fee = cryptoTradeFeeClp(detail, r.amount, units);
      amount = acquires ? amount - fee : amount + fee;
    }
    if (treatment === "acquire_at_amount") return { kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost: amount };
    if (treatment === "acquire_at_zero") return { kind: "acquire", date: r.occurred_on, movementId: r.id, units, cost: 0 };
    if (treatment === "dispose_at_amount") return { kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: amount };
    return { kind: "dispose", date: r.occurred_on, movementId: r.id, units, proceeds: 0 };
  });
  const rank = (e: TaxLotEvent) => (e.kind === "acquire" ? 0 : 1);
  return events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.movementId - b.movementId);
}

/** Pesos throughout; throws on a transfer touching the account or a row without units or kind. */
export function loadCryptoTaxLotEvents(accountId: number, feePolicy: CryptoFeePolicy = "excluded"): TaxLotEvent[] {
  const transfers = db
    .prepare(`SELECT COUNT(*) AS n FROM movements WHERE from_account_id = ? OR to_account_id = ?`)
    .get(accountId, accountId) as { n: number };
  if (transfers.n > 0) throw new Error(`Crypto tax lots: account ${accountId} has ${transfers.n} transfer(s)`);
  const rows = db
    .prepare(`SELECT id, occurred_on, amount, currency, units_delta FROM movements WHERE account_id = ?`)
    .all(accountId) as (CryptoTaxLotRow & { currency: string; units_delta: number | null })[];
  for (const r of rows) {
    if (r.currency !== "clp") throw new Error(`Crypto tax lots: movement ${r.id} is in ${r.currency}`);
    if (r.units_delta == null) throw new Error(`Crypto tax lots: movement ${r.id} has no units`);
  }
  const ids = rows.map((r) => r.id);
  return cryptoTaxLotEventsFromRows(rows, loadCryptoMovementKinds(ids), {
    policy: feePolicy,
    details: feePolicy === "excluded" ? loadCryptoTradeDetails(ids) : new Map(),
  });
}
