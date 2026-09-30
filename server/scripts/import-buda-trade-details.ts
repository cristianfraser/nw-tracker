/**
 * Imports Buda's own record of each trade (the «Detalles de la transacción» panel of buda.com/
 * historial, saved as a JSON of pipe-separated rows) into `crypto_trade_details`, pairing every
 * trade with the ledger movement it is: same kind (buy / sell / swap_in), coin and Chile day,
 * and the same pesos within 2 — what was paid for a buy (the quick buy's printed amount, or
 * units × price on an order-book buy), what was received for a sale (the printed amount, or
 * units × price − the peso commission). A sale's units must match exactly. Every trade must pair
 * with exactly one movement and every buy / sell / swap_in movement must get a trade, or nothing
 * is written.
 *
 * Usage (from server/):
 *   npx tsx scripts/import-buda-trade-details.ts --file=../cfraser/buda-trade-details-<date>.json [--apply]
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { parseChileanNumber } from "../src/chileanNumber.js";
import type { CryptoTradeDetail } from "../src/cryptoTradeDetails.js";

const APPLY = process.argv.includes("--apply");
const fileArg = process.argv.find((a) => a.startsWith("--file="));
if (!fileArg) throw new Error("--file=<buda-trade-details json> is required");
const file = fileArg.slice("--file=".length);
const PESO_TOLERANCE = 2;

type Parsed = Omit<CryptoTradeDetail, "movementId"> & {
  kind: "buy" | "sell" | "swap_in";
  coin: "BTC" | "ETH";
  day: string;
  /** The pesos the ledger row should carry. */
  ledgerClp: number | null;
  line: string;
};

const peso = (s: string) => parseChileanNumber(s.replace(/^\$/, ""));

function chileDayOf(created: string): { day: string; iso: string } {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}), (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/.exec(created);
  if (!m) throw new Error(`Unparseable creation time «${created}»`);
  let h = Number(m[4]) % 12;
  if (m[7] === "PM") h += 12;
  const day = `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`;
  return { day, iso: `${day}T${String(h).padStart(2, "0")}:${m[5]}:${m[6]}` };
}

function parseLine(line: string): Parsed {
  const [type, amount, clp, fee, price, created, id] = line.split("|");
  if (!type || !amount || !fee || !price || !created || !id) throw new Error(`Incomplete row «${line}»`);
  const [unitsText, coin] = amount.split(" ");
  if (coin !== "BTC" && coin !== "ETH") throw new Error(`Row «${line}»: coin ${coin}`);
  const units = parseChileanNumber(unitsText!);
  const isSell = type.startsWith("Venta");
  const isSwap = type.includes("ETH/BTC");
  if (!isSell && !type.startsWith("Compra")) throw new Error(`Row «${line}»: unknown type ${type}`);
  const priceCurrency: "clp" | "btc" = price.startsWith("$") ? "clp" : "btc";
  const priceValue = priceCurrency === "clp" ? peso(price) : parseChileanNumber(price);
  const [feeText, feeCoin] = fee.split(" ");
  const feeCurrency = fee.startsWith("$") ? "clp" : (feeCoin?.toLowerCase() as "btc" | "eth");
  if (feeCurrency !== "clp" && feeCurrency !== "btc" && feeCurrency !== "eth") throw new Error(`Row «${line}»: fee ${fee}`);
  const feeAmount = feeCurrency === "clp" ? peso(feeText!) : parseChileanNumber(feeText!);
  const { day, iso } = chileDayOf(created);
  let ledgerClp: number | null = null;
  if (!isSwap) {
    if (clp) ledgerClp = peso(clp);
    else if (isSell) {
      if (feeCurrency !== "clp") throw new Error(`Row «${line}»: an order-book sale with a coin fee`);
      ledgerClp = units * priceValue - feeAmount;
    } else ledgerClp = units * priceValue;
  }
  return {
    kind: isSell ? "sell" : isSwap ? "swap_in" : "buy",
    coin,
    day,
    ledgerClp,
    line,
    exchangeTradeId: id,
    units,
    price: priceValue,
    priceCurrency,
    feeAmount,
    feeCurrency,
    createdAt: iso,
  };
}

const rows = (JSON.parse(fs.readFileSync(file, "utf8")) as { rows: string[] }).rows.map(parseLine);
const movements = db
  .prepare(
    `SELECT m.id, m.occurred_on, m.amount, m.units_delta, k.kind, a.equity_ticker
       FROM movements m
       JOIN crypto_movement_kinds k ON k.movement_id = m.id
       JOIN accounts a ON a.id = m.account_id
      WHERE k.kind IN ('buy', 'sell', 'swap_in')`
  )
  .all() as { id: number; occurred_on: string; amount: number; units_delta: number; kind: string; equity_ticker: string }[];

const paired = new Map<number, Parsed>();
const problems: string[] = [];
for (const t of rows) {
  const hits = movements.filter(
    (m) =>
      !paired.has(m.id) &&
      m.kind === t.kind &&
      m.equity_ticker === `${t.coin}-USD` &&
      m.occurred_on === t.day &&
      (t.ledgerClp == null || Math.abs(Math.abs(m.amount) - t.ledgerClp) <= PESO_TOLERANCE) &&
      (t.kind !== "sell" || Math.abs(Math.abs(m.units_delta) - t.units) < 1e-9)
  );
  if (hits.length !== 1) problems.push(`  ${hits.length} ledger match(es) for «${t.line}»`);
  else paired.set(hits[0]!.id, t);
}
for (const m of movements) if (!paired.has(m.id)) problems.push(`  movement ${m.id} (${m.kind} ${m.occurred_on}) has no Buda trade`);
if (problems.length > 0) {
  console.error(`Buda trades do not pair with the ledger:\n${problems.join("\n")}`);
  process.exit(1);
}
console.log(`${rows.length} Buda trade(s) paired one to one with the ledger's buy / sell / swap_in movements.`);

if (!APPLY) {
  console.log("Report only — pass --apply to write crypto_trade_details.");
} else {
  const put = db.prepare(
    `INSERT INTO crypto_trade_details
       (movement_id, exchange_trade_id, units, price, price_currency, fee_amount, fee_currency, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(movement_id) DO UPDATE SET
       exchange_trade_id = excluded.exchange_trade_id, units = excluded.units, price = excluded.price,
       price_currency = excluded.price_currency, fee_amount = excluded.fee_amount,
       fee_currency = excluded.fee_currency, created_at = excluded.created_at`
  );
  db.transaction(() => {
    for (const [movementId, t] of paired) {
      put.run(movementId, t.exchangeTradeId, t.units, t.price, t.priceCurrency, t.feeAmount, t.feeCurrency, t.createdAt);
    }
  })();
  console.log(`Wrote ${paired.size} trade(s).`);
}
