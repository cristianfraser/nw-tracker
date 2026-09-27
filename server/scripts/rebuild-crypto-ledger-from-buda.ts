/**
 * Report-first rebuild of the Ether (`import:excel|key=eth`) and Bitcoin
 * (`import:excel|key=bitcoin`) coin ledgers from Buda's own history.
 *
 * Why. Both accounts still carry the rows the retired excel importer wrote from the «cripto-*»
 * sheets (`import:excel|cripto-sheet|…`): one row per sheet cell, dated at month-end. For Ether
 * the importer also misread cells — some deposits and withdrawals were taken as running totals
 * and the last row was forced to land on the sheet's footer balance — so the ledger's balance is
 * wrong for years and goes negative (valued at 0), which the daily P/L reads as a huge gain.
 * Buda's history (`cfraser/buda-history.csv`, a transcript of the exchange's own list) dates every
 * buy, sell and transfer to the day.
 *
 * Model — one single-leg row on the coin account per Buda event, paired 1:1 with the Buda CLP
 * buffer's existing single-leg rows (same day, same pesos), so every trade nets to zero inside
 * the crypto bucket and only money crossing Buda's edge moves the bucket's aportes:
 *   buy       +CLP paid, +coin received net of the exchange fee (FEE MODEL below)
 *   sell      −CLP received (the CSV's figure, net of the fee Buda takes in pesos), −coin sold
 *   coin_out  «Retiro → Billetera externa»: −market value of the coin sent (coin × the app's own
 *             close × fx for that day), −(coin sent + withdrawal fee). A withdrawal of capital at
 *             market, so only the fee lands in P/L.
 *   swap      a coin-for-coin order (the CSV keeps only the bought side; the paid side comes from
 *             the facts file): paid coin out / bought coin in net of fee, both legs at the market
 *             value of the coin received — bucket-neutral, the price gap is the paying coin's P/L.
 *   coin_in   a deposit of coin bought outside Buda: the sheet row recording that purchase is
 *             kept as is (facts `off_exchange`), the coin_in itself adds no row.
 * Buda's CLP buffer (`import:buda|key=buda_clp`) is not touched: its rows must already match the
 * CSV (checked), and budaWallet.ts / the deposits reconciliation branch on their notes.
 *
 * FEE MODEL. The export lists exchange orders («Ejecutada») at their gross coin amount; Buda took
 * its fee from the coin received, truncated to the coin's smallest unit. Quick trades
 * («Confirmada») carry the fee in the price: their amounts are what moved. What the export does
 * not show — per-order fee tiers, months pinned to the sheet's own totals, withdrawal fees, the
 * paid side of a swap, sell-alls, off-exchange purchases — lives in an untracked facts file
 * (`cfraser/buda-ledger-facts.json`, personal data like cc-cards.json), validated here against
 * the CSV and the DB: every entry must match an event, and the ledger must close to exactly zero
 * at each listed sell-all. Shape (coin amounts as decimal strings, exactly as Buda prints them;
 * `why` is free provenance text):
 *   default_taker_fee_ppm  integer, e.g. 8000 = 0,8 %
 *   order_fee_ppm          [{coin, date, amount, ppm, why}]   exchange buys at another rate
 *   month_net_pins         [{coin, month, net, why}]          a month's exchange buys net to this
 *   withdrawal_fees        [{coin, date, fee, why}]           fee on each withdrawal that day
 *   swaps                  [{date, buy_coin, buy_amount, pay_coin, pay_amount, why}]
 *   closing_sells          [{coin, date, why}]                balance exactly zero after that day
 *   off_exchange           [{coin, sheet_row_date, units, amount_clp, coin_in_date, why}]
 *
 * Usage (from server/):
 *   npx tsx scripts/rebuild-crypto-ledger-from-buda.ts                 # report only
 *   npx tsx scripts/rebuild-crypto-ledger-from-buda.ts --apply         # write + verify + commit
 *   … --buda=/abs/buda-history.csv --facts=/abs/buda-ledger-facts.json (defaults: ../cfraser/…)
 *
 * Apply runs in one IMMEDIATE transaction: it refuses unless the coin accounts hold exactly the
 * sheet rows (or exactly the rebuilt rows — then it reports «already applied»), deletes the sheet
 * rows except the kept off-exchange ones, inserts the rebuilt rows, asserts the coin balance at
 * every event date against the plan, and re-stamps the accounts' existing `valuations` rows
 * (value + units_snapshot, same dates) from the new ledger.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db.js";
import { chileCalendarTodayYmd } from "../src/chileDate.js";
import { equityCloseEod } from "../src/equityQuote.js";
import { fxForLiveMtm, fxRowOnOrBefore } from "../src/fxRates.js";
import { computeCryptoMtmClp, cryptoCoinCumulativeThroughDate } from "../src/cryptoValuation.js";

const APPLY = process.argv.includes("--apply");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

type Coin = "ETH" | "BTC";
const COINS: readonly Coin[] = ["ETH", "BTC"];
const COIN_ACCOUNT_KEY: Record<Coin, string> = {
  ETH: "import:excel|key=eth",
  BTC: "import:excel|key=bitcoin",
};
const COIN_TICKER: Record<Coin, "ETH-USD" | "BTC-USD"> = { ETH: "ETH-USD", BTC: "BTC-USD" };
const BUFFER_KEY = "import:buda|key=buda_clp";
const SHEET_NOTE_PREFIX = "import:excel|cripto-sheet|";
const NEW_NOTE_PREFIX = "import:buda|coin|";

/** 1 coin = 1e9 nano; Buda prints ETH to 9 decimals and BTC to 8, so nano is exact for both. */
const NANO = 1_000_000_000n;
/** Smallest amount each coin moves in (fees truncate to it): 1 nanoether, 1 satoshi. */
const ATOM_NANO: Record<Coin, bigint> = { ETH: 1n, BTC: 10n };
/** Sanity band for any fee rate the model produces (0 – 0,9 %). */
const MAX_FEE_PPM = 9000n;

// ── small helpers ─────────────────────────────────────────────────────────────────────────
function fail(msg: string): never {
  console.error(`\nABORT: ${msg}`);
  process.exit(1);
}

function parseNano(text: string, where: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(String(text).trim());
  if (!m) fail(`${where}: not a coin amount with ≤ 9 decimals: "${text}"`);
  return BigInt(m[1]!) * NANO + BigInt((m[2] ?? "").padEnd(9, "0"));
}

function fmtNano(n: bigint): string {
  const neg = n < 0n;
  const a = neg ? -n : n;
  return `${neg ? "-" : ""}${a / NANO}.${(a % NANO).toString().padStart(9, "0")}`;
}

function nanoToNumber(n: bigint): number {
  return Number(fmtNano(n));
}

/** Exchange fee on a gross amount, truncated to the coin's smallest unit. */
function orderFeeNano(coin: Coin, grossNano: bigint, ppm: bigint): bigint {
  const atom = ATOM_NANO[coin];
  return ((grossNano * ppm) / (1_000_000n * atom)) * atom;
}

function monthEnd(ym: string): string {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function groupThousands(n: number): string {
  const r = Math.round(n);
  const s = String(Math.abs(r)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return r < 0 ? `-${s}` : s;
}

function fmtClp(n: number): string {
  return groupThousands(n).padStart(12);
}

function fmtSigned(n: number): string {
  return `${n >= 0 ? "+" : ""}${groupThousands(n)}`;
}

function fmtUnits(n: number): string {
  return n.toFixed(9).padStart(14);
}

function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isCoin(s: unknown): s is Coin {
  return s === "ETH" || s === "BTC";
}

// ── facts file (untracked personal data; see header) ──────────────────────────────────────
type Facts = {
  defaultTakerFeePpm: bigint;
  orderFeePpm: Map<string, bigint>; // coin|date|gross nano
  monthNetPins: { coin: Coin; month: string; netNano: bigint }[];
  withdrawalFees: Map<string, bigint>; // coin|date
  swaps: { date: string; buyCoin: Coin; buyNano: bigint; payCoin: Coin; payNano: bigint; payAmount: string }[];
  closingSells: { coin: Coin; date: string }[];
  offExchange: { coin: Coin; sheetRowDate: string; unitsNano: bigint; units: string; amountClp: number; coinInDate: string }[];
};

function loadFacts(file: string): Facts {
  if (!fs.existsSync(file)) fail(`facts file not found: ${file} (pass --facts=<path>)`);
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch (e) {
    fail(`facts file ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const known = new Set(["default_taker_fee_ppm", "order_fee_ppm", "month_net_pins", "withdrawal_fees", "swaps", "closing_sells", "off_exchange"]);
  for (const k of Object.keys(raw)) if (!known.has(k)) fail(`facts: unknown key "${k}"`);
  const list = (key: string): Record<string, unknown>[] => {
    const v = raw[key];
    if (!Array.isArray(v)) fail(`facts: "${key}" must be an array`);
    return v as Record<string, unknown>[];
  };
  const ppm = (v: unknown, where: string): bigint => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || BigInt(v) > MAX_FEE_PPM) fail(`${where}: fee ppm must be an integer in 0..${MAX_FEE_PPM}`);
    return BigInt(v);
  };
  const coin = (v: unknown, where: string): Coin => (isCoin(v) ? v : fail(`${where}: coin must be ETH or BTC`));
  const ymd = (v: unknown, where: string): string => (isYmd(v) ? v : fail(`${where}: date must be YYYY-MM-DD`));
  const str = (v: unknown, where: string): string => (typeof v === "string" ? v : fail(`${where}: expected a decimal string`));

  const facts: Facts = {
    defaultTakerFeePpm: ppm(raw.default_taker_fee_ppm, "facts.default_taker_fee_ppm"),
    orderFeePpm: new Map(),
    monthNetPins: [],
    withdrawalFees: new Map(),
    swaps: [],
    closingSells: [],
    offExchange: [],
  };
  list("order_fee_ppm").forEach((e, i) => {
    const w = `facts.order_fee_ppm[${i}]`;
    const key = `${coin(e.coin, w)}|${ymd(e.date, w)}|${parseNano(str(e.amount, w), w)}`;
    if (facts.orderFeePpm.has(key)) fail(`${w}: duplicate entry`);
    facts.orderFeePpm.set(key, ppm(e.ppm, w));
  });
  list("month_net_pins").forEach((e, i) => {
    const w = `facts.month_net_pins[${i}]`;
    if (typeof e.month !== "string" || !/^\d{4}-\d{2}$/.test(e.month)) fail(`${w}: month must be YYYY-MM`);
    facts.monthNetPins.push({ coin: coin(e.coin, w), month: e.month, netNano: parseNano(str(e.net, w), w) });
  });
  list("withdrawal_fees").forEach((e, i) => {
    const w = `facts.withdrawal_fees[${i}]`;
    const key = `${coin(e.coin, w)}|${ymd(e.date, w)}`;
    if (facts.withdrawalFees.has(key)) fail(`${w}: duplicate ${key}`);
    facts.withdrawalFees.set(key, parseNano(str(e.fee, w), w));
  });
  list("swaps").forEach((e, i) => {
    const w = `facts.swaps[${i}]`;
    const payAmount = str(e.pay_amount, w);
    facts.swaps.push({
      date: ymd(e.date, w),
      buyCoin: coin(e.buy_coin, w),
      buyNano: parseNano(str(e.buy_amount, w), w),
      payCoin: coin(e.pay_coin, w),
      payNano: parseNano(payAmount, w),
      payAmount,
    });
  });
  list("closing_sells").forEach((e, i) => {
    const w = `facts.closing_sells[${i}]`;
    facts.closingSells.push({ coin: coin(e.coin, w), date: ymd(e.date, w) });
  });
  list("off_exchange").forEach((e, i) => {
    const w = `facts.off_exchange[${i}]`;
    const units = str(e.units, w);
    if (typeof e.amount_clp !== "number" || !Number.isInteger(e.amount_clp) || e.amount_clp <= 0) fail(`${w}: amount_clp must be a positive integer`);
    facts.offExchange.push({
      coin: coin(e.coin, w),
      sheetRowDate: ymd(e.sheet_row_date, w),
      unitsNano: parseNano(units, w),
      units,
      amountClp: e.amount_clp,
      coinInDate: ymd(e.coin_in_date, w),
    });
  });
  return facts;
}

// ── Buda CSV ──────────────────────────────────────────────────────────────────────────────
type BudaKind = "buy" | "sell" | "coin_out" | "coin_in" | "coin_swap" | "abono_clp" | "retiro_clp";
const BUDA_KINDS: readonly BudaKind[] = ["buy", "sell", "coin_out", "coin_in", "coin_swap", "abono_clp", "retiro_clp"];
const BUDA_STATUSES = new Set(["Ejecutada", "Confirmada", "Abonado", "Transferido", "Rechazado"]);

type BudaRow = {
  line: number;
  date: string;
  kind: BudaKind;
  status: string;
  coin: Coin | null;
  coinText: string | null;
  coinNano: bigint | null;
  clp: number | null;
};

function parseBudaCsv(file: string): BudaRow[] {
  if (!fs.existsSync(file)) fail(`Buda history not found: ${file} (pass --buda=<path>)`);
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = lines.shift();
  if (header !== "date,kind,status,coin,coin_amount,clp") fail(`unexpected Buda CSV header: ${header}`);
  return lines.map((raw, i) => {
    const where = `Buda CSV line ${i + 2}`;
    const cells = raw.split(",");
    if (cells.length !== 6) fail(`${where}: expected 6 cells, got ${cells.length}`);
    const [date, kind, status, coin, coinAmount, clp] = cells as [string, string, string, string, string, string];
    if (!isYmd(date)) fail(`${where}: bad date "${date}"`);
    if (!BUDA_KINDS.includes(kind as BudaKind)) fail(`${where}: unknown kind "${kind}"`);
    if (!BUDA_STATUSES.has(status)) fail(`${where}: unknown status "${status}"`);
    if (coin !== "" && !isCoin(coin)) fail(`${where}: unknown coin "${coin}"`);
    const isClpKind = kind === "abono_clp" || kind === "retiro_clp";
    if (isClpKind !== (coin === "")) fail(`${where}: coin column inconsistent with kind ${kind}`);
    if (isClpKind !== (coinAmount === "")) fail(`${where}: coin amount inconsistent with kind ${kind}`);
    if (clp !== "" && !/^\d+$/.test(clp)) fail(`${where}: bad CLP amount "${clp}"`);
    const needsClp = kind === "buy" || kind === "sell" || isClpKind;
    if (needsClp !== (clp !== "")) fail(`${where}: CLP column inconsistent with kind ${kind}`);
    return {
      line: i + 2,
      date,
      kind: kind as BudaKind,
      status,
      coin: coin === "" ? null : (coin as Coin),
      coinText: coinAmount === "" ? null : coinAmount,
      coinNano: coinAmount === "" ? null : parseNano(coinAmount, where),
      clp: clp === "" ? null : Number(clp),
    };
  });
}

// ── DB state ──────────────────────────────────────────────────────────────────────────────
type AccountRow = { id: number; name: string; equity_ticker: string | null };
type MovementRow = {
  id: number;
  account_id: number | null;
  from_account_id: number | null;
  to_account_id: number | null;
  amount: number;
  currency: string;
  counter_amount: number | null;
  occurred_on: string;
  note: string | null;
  units_delta: number | null;
  flow_kind: string | null;
};

function accountByImportKey(key: string): AccountRow {
  const row = db.prepare(`SELECT id, name, equity_ticker FROM accounts WHERE import_key = ?`).get(key) as
    | AccountRow
    | undefined;
  if (!row) fail(`account with import_key ${key} not found`);
  return row;
}

function movementsTouching(accountId: number): MovementRow[] {
  return db
    .prepare(
      `SELECT id, account_id, from_account_id, to_account_id, amount, currency, counter_amount, occurred_on,
              note, units_delta, flow_kind
       FROM movements
       WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?
       ORDER BY occurred_on, id`
    )
    .all(accountId, accountId, accountId) as MovementRow[];
}

/** The buffer must hold exactly the CSV's peso legs: abono +, retiro −, buy −, sell +. */
function checkBufferMatchesCsv(bufferId: number, rows: readonly BudaRow[]): number {
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const expected = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "Rechazado" || r.clp == null) continue;
    const sign = r.kind === "abono_clp" || r.kind === "sell" ? 1 : -1;
    const tag = r.kind === "abono_clp" ? "abono" : r.kind === "retiro_clp" ? "retiro" : r.kind;
    bump(expected, `${r.date}|import:buda|${tag}|${sign * r.clp}`);
  }
  const actual = new Map<string, number>();
  for (const m of movementsTouching(bufferId)) {
    if (m.account_id !== bufferId || m.currency !== "clp" || m.units_delta != null || m.flow_kind != null) {
      fail(`Buda buffer movement ${m.id} is not a plain single-leg CLP row`);
    }
    bump(actual, `${m.occurred_on}|${m.note}|${m.amount}`);
  }
  const problems: string[] = [];
  for (const k of new Set([...expected.keys(), ...actual.keys()])) {
    const e = expected.get(k) ?? 0;
    const a = actual.get(k) ?? 0;
    if (e !== a) problems.push(`  ${k}: CSV ${e} × vs buffer ${a} ×`);
  }
  if (problems.length > 0) fail(`Buda buffer does not match the CSV:\n${problems.join("\n")}`);
  return [...expected.values()].reduce((s, v) => s + v, 0);
}

// ── plan ──────────────────────────────────────────────────────────────────────────────────
type PlannedKind = "buy" | "sell" | "coin_out" | "swap_in" | "swap_out";
type PlannedRow = {
  coin: Coin;
  occurred_on: string;
  kind: PlannedKind;
  amount: number;
  unitsNano: bigint;
  printed: string;
  feeText: string | null;
  note: string;
};

function marketValueClp(coin: Coin, ymd: string, unitsNano: bigint): number {
  const close = equityCloseEod(COIN_TICKER[coin], ymd);
  if (close == null || !Number.isFinite(close)) fail(`no ${COIN_TICKER[coin]} close on or before ${ymd}`);
  const fx = fxForLiveMtm(ymd);
  if (!fx || !(fx.clp_per_usd > 0)) fail(`no USD/CLP rate for ${ymd}`);
  return Math.round(nanoToNumber(unitsNano) * close * fx.clp_per_usd);
}

function rowNote(kind: PlannedKind, coin: Coin, date: string, printed: string, extra: string): string {
  return `${NEW_NOTE_PREFIX}${kind}|coin=${coin}|day=${date}|amount=${printed}${extra}`;
}

function planCoinRows(rows: readonly BudaRow[], facts: Facts): PlannedRow[] {
  const live = rows.filter((r) => r.status !== "Rechazado");

  // Buys and swap-ins: coin received per order. Exchange orders net of the fee.
  type Buy = { row: BudaRow; coin: Coin; gross: bigint; net: bigint; exchange: boolean };
  const buys: Buy[] = [];
  const usedOrderFees = new Set<string>();
  for (const r of live) {
    if (r.kind !== "buy" && r.kind !== "coin_swap") continue;
    const coin = r.coin!;
    const gross = r.coinNano!;
    if (r.status === "Confirmada") {
      buys.push({ row: r, coin, gross, net: gross, exchange: false });
    } else if (r.status === "Ejecutada") {
      const key = `${coin}|${r.date}|${gross}`;
      const override = facts.orderFeePpm.get(key);
      if (override != null) usedOrderFees.add(key);
      buys.push({ row: r, coin, gross, net: gross - orderFeeNano(coin, gross, override ?? facts.defaultTakerFeePpm), exchange: true });
    } else {
      fail(`Buda CSV line ${r.line}: ${r.kind} with status ${r.status}`);
    }
  }
  for (const k of facts.orderFeePpm.keys()) {
    if (!usedOrderFees.has(k)) fail(`facts order_fee_ppm entry ${k.split("|").slice(0, 2).join(" ")} matches no exchange order`);
  }

  // Pinned months: per-order rates first, then the gap to the pinned total spread pro rata.
  for (const pin of facts.monthNetPins) {
    const key = `${pin.coin}|${pin.month}`;
    const month = buys.filter((b) => b.exchange && b.coin === pin.coin && b.row.kind === "buy" && b.row.date.startsWith(pin.month));
    if (month.length === 0) fail(`facts month_net_pins ${key}: no exchange buys in that month`);
    const atom = ATOM_NANO[pin.coin];
    const gross = month.reduce((s, b) => s + b.gross, 0n);
    const fee = gross - pin.netNano;
    if (fee < 0n || fee * 1_000_000n > gross * MAX_FEE_PPM) fail(`facts month_net_pins ${key}: implied fee outside 0–0,9 %`);
    const gap = pin.netNano - month.reduce((s, b) => s + b.net, 0n);
    if (gap % atom !== 0n) fail(`facts month_net_pins ${key}: not a whole number of ${pin.coin} units`);
    let assigned = 0n;
    for (const b of month) {
      const g = ((gap * b.gross) / gross / atom) * atom; // truncates toward zero for either sign
      b.net += g;
      assigned += g;
    }
    const largest = month.reduce((a, b) => (b.gross > a.gross ? b : a));
    largest.net += gap - assigned; // leftover units on the largest order, so the month sums exactly
  }

  const planned: PlannedRow[] = [];
  const usedSwaps = new Set<number>();
  for (const b of buys) {
    const r = b.row;
    const fee = b.gross - b.net;
    const feeNote = b.exchange ? `|fee=${fmtNano(fee)}` : "";
    if (r.kind === "coin_swap") {
      const si = facts.swaps.findIndex((s) => s.date === r.date && s.buyCoin === b.coin && s.buyNano === b.gross);
      if (si < 0) fail(`Buda CSV line ${r.line}: no facts.swaps entry for the ${b.coin} swap on ${r.date}`);
      usedSwaps.add(si);
      const swap = facts.swaps[si]!;
      if (swap.payCoin === b.coin) fail(`facts.swaps[${si}]: pays with the coin it buys`);
      const value = marketValueClp(b.coin, r.date, b.gross);
      planned.push({
        coin: b.coin,
        occurred_on: r.date,
        kind: "swap_in",
        amount: value,
        unitsNano: b.net,
        printed: r.coinText!,
        feeText: b.exchange ? fmtNano(fee) : null,
        note: rowNote("swap_in", b.coin, r.date, r.coinText!, `${feeNote}|paid=${swap.payAmount} ${swap.payCoin}`),
      });
      planned.push({
        coin: swap.payCoin,
        occurred_on: r.date,
        kind: "swap_out",
        amount: -value,
        unitsNano: -swap.payNano,
        printed: swap.payAmount,
        feeText: null,
        note: rowNote("swap_out", swap.payCoin, r.date, swap.payAmount, `|for=${r.coinText} ${b.coin}`),
      });
      continue;
    }
    planned.push({
      coin: b.coin,
      occurred_on: r.date,
      kind: "buy",
      amount: r.clp!,
      unitsNano: b.net,
      printed: r.coinText!,
      feeText: b.exchange ? fmtNano(fee) : null,
      note: rowNote("buy", b.coin, r.date, r.coinText!, feeNote),
    });
  }
  facts.swaps.forEach((s, i) => {
    if (!usedSwaps.has(i)) fail(`facts.swaps[${i}] (${s.date}) matches no Buda swap`);
  });

  const usedWithdrawalFees = new Set<string>();
  const usedOffExchange = new Set<number>();
  for (const r of live) {
    const coin = r.coin;
    if (r.kind === "sell") {
      planned.push({
        coin: coin!,
        occurred_on: r.date,
        kind: "sell",
        amount: -r.clp!,
        unitsNano: -r.coinNano!,
        printed: r.coinText!,
        feeText: null,
        note: rowNote("sell", coin!, r.date, r.coinText!, ""),
      });
    } else if (r.kind === "coin_out") {
      const key = `${coin}|${r.date}`;
      const fee = facts.withdrawalFees.get(key);
      if (fee == null) fail(`Buda CSV line ${r.line}: no facts.withdrawal_fees entry for ${key}`);
      usedWithdrawalFees.add(key);
      planned.push({
        coin: coin!,
        occurred_on: r.date,
        kind: "coin_out",
        amount: -marketValueClp(coin!, r.date, r.coinNano!),
        unitsNano: -(r.coinNano! + fee),
        printed: r.coinText!,
        feeText: fmtNano(fee),
        note: rowNote("coin_out", coin!, r.date, r.coinText!, `|fee=${fmtNano(fee)}`),
      });
    } else if (r.kind === "coin_in") {
      const oi = facts.offExchange.findIndex((o) => o.coin === coin && o.coinInDate === r.date && o.unitsNano === r.coinNano);
      if (oi < 0) fail(`Buda CSV line ${r.line}: coin_in of ${coin} on ${r.date} has no facts.off_exchange purchase`);
      if (usedOffExchange.has(oi)) fail(`facts.off_exchange[${oi}] matches two coin_ins`);
      usedOffExchange.add(oi);
    }
  }
  for (const k of facts.withdrawalFees.keys()) if (!usedWithdrawalFees.has(k)) fail(`facts withdrawal_fees ${k} matches no Buda withdrawal`);
  facts.offExchange.forEach((o, i) => {
    if (!usedOffExchange.has(i)) fail(`facts.off_exchange[${i}] matches no Buda coin_in`);
  });

  const kindOrder: Record<PlannedKind, number> = { buy: 0, swap_in: 0, swap_out: 1, coin_out: 2, sell: 3 };
  planned.sort(
    (a, b) =>
      a.coin.localeCompare(b.coin) ||
      a.occurred_on.localeCompare(b.occurred_on) ||
      kindOrder[a.kind] - kindOrder[b.kind] ||
      a.note.localeCompare(b.note)
  );
  const notes = new Set<string>();
  for (const p of planned) {
    if (notes.has(p.note)) fail(`duplicate planned note ${p.note}`);
    notes.add(p.note);
    if (p.amount === 0) fail(`planned row with a zero CLP amount: ${p.note}`);
  }
  return planned;
}

// ── ledger math (same rules as cryptoValuation / accountDeposits for single-leg rows) ─────
type LedgerRow = { occurred_on: string; amount: number; units: number; countsAsFlow: boolean };

function unitsThrough(rows: readonly LedgerRow[], ymd: string): number {
  let u = 0;
  for (const r of rows) if (r.occurred_on <= ymd) u += r.units;
  return u;
}

function markClp(coin: Coin, units: number, ymd: string): number {
  if (!(units > 1e-12)) return 0; // computeCryptoMtmClp values a non-positive balance at 0
  const close = equityCloseEod(COIN_TICKER[coin], ymd);
  const fx = fxForLiveMtm(ymd);
  if (close == null || !fx) fail(`no price/fx for ${coin} on ${ymd}`);
  return units * close * fx.clp_per_usd;
}

function markUsd(coin: Coin, units: number, ymd: string): number {
  if (!(units > 1e-12)) return 0;
  const close = equityCloseEod(COIN_TICKER[coin], ymd);
  if (close == null) fail(`no price for ${coin} on ${ymd}`);
  return units * close;
}

function flowUsd(amount: number, ymd: string): number {
  const fx = fxRowOnOrBefore(ymd);
  if (!fx || !(fx.clp_per_usd > 0)) fail(`no USD/CLP rate on or before ${ymd}`);
  return amount / fx.clp_per_usd;
}

type MonthStat = { me: string; units: number; value: number; flow: number; pl: number };

function monthStats(coin: Coin, rows: readonly LedgerRow[], months: readonly string[], today: string): MonthStat[] {
  const out: MonthStat[] = [];
  let prior = 0;
  for (const ym of months) {
    const me = monthEnd(ym) > today ? today : monthEnd(ym);
    const units = unitsThrough(rows, me);
    const value = markClp(coin, units, me);
    let flow = 0;
    for (const r of rows) if (r.countsAsFlow && r.occurred_on.startsWith(ym)) flow += r.amount;
    out.push({ me, units, value, flow, pl: value - prior - flow });
    prior = value;
  }
  return out;
}

function totals(coin: Coin, rows: readonly LedgerRow[], today: string) {
  const units = unitsThrough(rows, today);
  let flowClp = 0;
  let flowU = 0;
  for (const r of rows) {
    if (!r.countsAsFlow) continue;
    flowClp += r.amount;
    flowU += flowUsd(r.amount, r.occurred_on);
  }
  const valueClp = markClp(coin, units, today);
  const valueUsd = markUsd(coin, units, today);
  return { units, flowClp, valueClp, plClp: valueClp - flowClp, plUsd: valueUsd - flowU };
}

function monthsBetween(firstYmd: string, lastYmd: string): string[] {
  const out: string[] = [];
  let [y, m] = firstYmd.slice(0, 7).split("-").map(Number) as [number, number];
  const [ly, lm] = lastYmd.slice(0, 7).split("-").map(Number) as [number, number];
  while (y < ly || (y === ly && m <= lm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

/** Exact running balance at the end of each event date, in nano. */
function dailyBalancesNano(events: readonly { d: string; u: bigint }[]): Map<string, bigint> {
  const byDay = new Map<string, bigint>();
  for (const e of events) byDay.set(e.d, (byDay.get(e.d) ?? 0n) + e.u);
  const out = new Map<string, bigint>();
  let bal = 0n;
  for (const d of [...byDay.keys()].sort()) {
    bal += byDay.get(d)!;
    out.set(d, bal);
  }
  return out;
}

// ── main ──────────────────────────────────────────────────────────────────────────────────
function argPath(name: string, fallback: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? path.resolve(arg.slice(name.length + 3)) : path.resolve(__dirname, "..", "..", "cfraser", fallback);
}

function main(): void {
  const budaFile = argPath("buda", "buda-history.csv");
  const factsFile = argPath("facts", "buda-ledger-facts.json");
  const csv = parseBudaCsv(budaFile);
  const facts = loadFacts(factsFile);
  const today = chileCalendarTodayYmd();

  const accounts = {} as Record<Coin, AccountRow>;
  for (const c of COINS) {
    accounts[c] = accountByImportKey(COIN_ACCOUNT_KEY[c]);
    if (accounts[c].equity_ticker !== COIN_TICKER[c]) {
      fail(`${accounts[c].name} has ticker ${accounts[c].equity_ticker}, expected ${COIN_TICKER[c]}`);
    }
  }
  const buffer = accountByImportKey(BUFFER_KEY);

  console.log(`Buda history: ${budaFile}`);
  console.log(`Facts:        ${factsFile}`);
  const rejected = csv.filter((r) => r.status === "Rechazado");
  console.log(`  ${csv.length} rows; ${rejected.length} rejected and skipped`);
  const matched = checkBufferMatchesCsv(buffer.id, csv);
  console.log(`  Buda CLP buffer (#${buffer.id}): all ${matched} peso legs match the CSV (date, kind, amount)`);

  const planned = planCoinRows(csv, facts);

  // Current state per coin: sheet rows (to replace), kept off-exchange rows, or rebuilt rows.
  const current = {} as Record<Coin, MovementRow[]>;
  const toDelete: MovementRow[] = [];
  const rebuiltPresent: MovementRow[] = [];
  const kept: MovementRow[] = [];
  for (const c of COINS) {
    const acc = accounts[c];
    current[c] = movementsTouching(acc.id);
    for (const m of current[c]) {
      if (m.account_id !== acc.id) fail(`${acc.name}: transfer movement ${m.id} touches the account — not modeled here`);
      if (m.currency !== "clp" || m.flow_kind != null || m.counter_amount != null) {
        fail(`${acc.name}: movement ${m.id} is not a plain CLP single-leg row`);
      }
      const note = m.note ?? "";
      const offExchange = facts.offExchange.find(
        (o) =>
          o.coin === c &&
          note.startsWith(`${SHEET_NOTE_PREFIX}${c}|dep|`) &&
          m.occurred_on === o.sheetRowDate &&
          m.amount === o.amountClp &&
          m.units_delta != null &&
          Math.abs(m.units_delta - nanoToNumber(o.unitsNano)) < 1e-12
      );
      if (offExchange) kept.push(m);
      else if (note.startsWith(`${SHEET_NOTE_PREFIX}${c}|`)) toDelete.push(m);
      else if (note.startsWith(NEW_NOTE_PREFIX)) rebuiltPresent.push(m);
      else fail(`${acc.name}: movement ${m.id} (${m.occurred_on}) is neither a sheet row nor a rebuilt row`);
    }
  }
  if (kept.length !== facts.offExchange.length) {
    fail(`expected ${facts.offExchange.length} kept off-exchange sheet row(s), found ${kept.length}`);
  }
  const keptIds = new Set(kept.map((m) => m.id));
  if (toDelete.length > 0 && rebuiltPresent.length > 0) {
    fail(`both sheet rows and ${rebuiltPresent.length} rebuilt row(s) are present — partial state, resolve by hand`);
  }
  if (toDelete.length === 0) {
    const want = new Map(planned.map((p) => [p.note, p]));
    const drift: string[] = [];
    for (const m of rebuiltPresent) {
      const p = want.get(m.note ?? "");
      if (!p) drift.push(`  unexpected #${m.id} ${m.note}`);
      else if (
        p.occurred_on !== m.occurred_on ||
        p.amount !== m.amount ||
        Math.abs(nanoToNumber(p.unitsNano) - (m.units_delta ?? Number.NaN)) > 1e-12
      ) {
        drift.push(`  #${m.id} ${m.note}: stored ${m.occurred_on} ${m.amount} ${m.units_delta}`);
      }
      want.delete(m.note ?? "");
    }
    for (const p of want.values()) drift.push(`  missing ${p.note}`);
    if (drift.length > 0) fail(`rebuilt rows differ from the plan:\n${drift.join("\n")}`);
    console.log(`\nAlready applied: the coin accounts hold exactly the ${planned.length} rebuilt rows (+ ${kept.length} kept). Nothing to do.`);
    return;
  }

  // Exact plan balances: never negative at a day's end, zero right after each sell-all.
  const planEvents = (c: Coin) => [
    ...planned.filter((p) => p.coin === c).map((p) => ({ d: p.occurred_on, u: p.unitsNano })),
    ...facts.offExchange.filter((o) => o.coin === c).map((o) => ({ d: o.sheetRowDate, u: o.unitsNano })),
  ];
  const planBalances = {} as Record<Coin, Map<string, bigint>>;
  for (const c of COINS) {
    planBalances[c] = dailyBalancesNano(planEvents(c));
    for (const [d, bal] of planBalances[c]) if (bal < 0n) fail(`${c} balance negative (${fmtNano(bal)}) at the end of ${d}`);
  }
  for (const s of facts.closingSells) {
    if (!planned.some((p) => p.coin === s.coin && p.kind === "sell" && p.occurred_on === s.date)) {
      fail(`facts closing_sells ${s.coin}|${s.date} matches no sell`);
    }
    const bal = planBalances[s.coin].get(s.date)!;
    if (bal !== 0n) fail(`${s.coin} does not close at the ${s.date} sell-all: ${fmtNano(bal)} left (fee model drift)`);
  }

  // ── report ──
  const beforeRows = (c: Coin): LedgerRow[] =>
    current[c].map((m) => ({
      occurred_on: m.occurred_on,
      amount: m.amount,
      units: m.units_delta ?? 0,
      countsAsFlow: !(m.note ?? "").includes("cripto-coin-only-wdw"),
    }));
  const afterRows = (c: Coin): LedgerRow[] => [
    ...planned
      .filter((p) => p.coin === c)
      .map((p) => ({ occurred_on: p.occurred_on, amount: p.amount, units: nanoToNumber(p.unitsNano), countsAsFlow: true })),
    ...kept
      .filter((m) => current[c].includes(m))
      .map((m) => ({ occurred_on: m.occurred_on, amount: m.amount, units: m.units_delta ?? 0, countsAsFlow: true })),
  ];

  for (const c of COINS) {
    const acc = accounts[c];
    console.log(`\n══ ${acc.name} (#${acc.id}, ${COIN_TICKER[c]}) ══`);
    const removed = current[c].filter((m) => !keptIds.has(m.id));
    console.log(`Sheet rows removed (${removed.length}):`);
    for (const m of removed) {
      console.log(`  - #${m.id} ${m.occurred_on} ${fmtClp(m.amount)} CLP ${fmtUnits(m.units_delta ?? 0)}  ${m.note}`);
    }
    for (const m of current[c].filter((x) => keptIds.has(x.id))) {
      console.log(`Kept (off-exchange purchase, reaches Buda later as a coin_in):`);
      console.log(`  = #${m.id} ${m.occurred_on} ${fmtClp(m.amount)} CLP ${fmtUnits(m.units_delta ?? 0)}  ${m.note}`);
    }
    const mine = planned.filter((p) => p.coin === c);
    console.log(`Rebuilt rows inserted (${mine.length}):`);
    for (const p of mine) {
      console.log(
        `  + ${p.occurred_on} ${p.kind.padEnd(8)} ${fmtClp(p.amount)} CLP ${fmtUnits(nanoToNumber(p.unitsNano))}` +
          `  balance ${fmtUnits(nanoToNumber(planBalances[c].get(p.occurred_on)!))}` +
          `  (printed ${p.printed}${p.feeText ? `, fee ${p.feeText}` : ""})`
      );
    }

    const before = beforeRows(c);
    const after = afterRows(c);
    const first = [...before, ...after].map((r) => r.occurred_on).sort()[0]!;
    const months = monthsBetween(first, today);
    const mb = monthStats(c, before, months, today);
    const ma = monthStats(c, after, months, today);
    console.log(`\nMonth-ends where the ledgers differ (units / value / aportes / P&L; CLP):`);
    console.log(
      `  ${"month-end".padEnd(10)} ${"units before".padStart(14)} ${"units after".padStart(14)} ${"value before".padStart(12)}` +
        ` ${"value after".padStart(12)} ${"flow before".padStart(12)} ${"flow after".padStart(12)} ${"P&L before".padStart(12)} ${"P&L after".padStart(12)}`
    );
    for (let i = 0; i < months.length; i++) {
      const b = mb[i]!;
      const a = ma[i]!;
      if (Math.abs(b.units - a.units) < 1e-9 && Math.abs(b.flow - a.flow) < 0.5 && Math.abs(b.pl - a.pl) < 0.5) continue;
      console.log(
        `  ${b.me} ${fmtUnits(b.units)} ${fmtUnits(a.units)} ${fmtClp(b.value)} ${fmtClp(a.value)}` +
          ` ${fmtClp(b.flow)} ${fmtClp(a.flow)} ${fmtClp(b.pl)} ${fmtClp(a.pl)}`
      );
    }
    const moves = months
      .map((ym, i) => ({ ym, d: ma[i]!.pl - mb[i]!.pl }))
      .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
      .slice(0, 8);
    console.log(`Largest monthly P&L changes: ${moves.map((m) => `${m.ym} ${fmtSigned(m.d)}`).join(" · ")}`);
    const tb = totals(c, before, today);
    const ta = totals(c, after, today);
    console.log(`All-time (through ${today}):`);
    console.log(`  units now   ${fmtUnits(tb.units)} → ${fmtUnits(ta.units)}`);
    console.log(`  aportes CLP ${fmtClp(tb.flowClp)} → ${fmtClp(ta.flowClp)}`);
    console.log(`  value CLP   ${fmtClp(tb.valueClp)} → ${fmtClp(ta.valueClp)}`);
    console.log(`  P&L CLP     ${fmtClp(tb.plClp)} → ${fmtClp(ta.plClp)}  (${fmtSigned(ta.plClp - tb.plClp)})`);
    console.log(
      `  P&L USD     ${tb.plUsd.toFixed(2).padStart(12)} → ${ta.plUsd.toFixed(2).padStart(12)}` +
        `  (${ta.plUsd - tb.plUsd >= 0 ? "+" : ""}${(ta.plUsd - tb.plUsd).toFixed(2)}; flows at the day's observed rate)`
    );
  }

  if (!APPLY) {
    console.log(`\nReport only — re-run with --apply to replace ${toDelete.length} sheet rows with ${planned.length} rebuilt rows.`);
    return;
  }

  // ── apply ──
  const del = db.prepare(`DELETE FROM movements WHERE id = ?`);
  const ins = db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
     VALUES (?, ?, 'clp', ?, ?, ?)`
  );
  const restamp = db.prepare(`UPDATE valuations SET value = ?, units_snapshot = ? WHERE id = ?`);
  let restamped = 0;
  db.transaction(() => {
    for (const m of toDelete) del.run(m.id);
    for (const p of planned) ins.run(accounts[p.coin].id, p.amount, p.occurred_on, p.note, nanoToNumber(p.unitsNano));
    for (const c of COINS) {
      const id = accounts[c].id;
      for (const [d, bal] of planBalances[c]) {
        const stored = cryptoCoinCumulativeThroughDate(id, d);
        if (Math.abs(stored - nanoToNumber(bal)) > 1e-9) {
          throw new Error(`${c} units through ${d}: stored ${stored}, planned ${fmtNano(bal)}`);
        }
      }
      const vals = db
        .prepare(`SELECT id, as_of_date, currency FROM valuations WHERE account_id = ? ORDER BY as_of_date`)
        .all(id) as { id: number; as_of_date: string; currency: string }[];
      for (const v of vals) {
        if (v.currency !== "clp") throw new Error(`valuation ${v.id} is not CLP`);
        const value = computeCryptoMtmClp(id, v.as_of_date);
        if (value == null || !Number.isFinite(value)) throw new Error(`${c}: no mark for ${v.as_of_date}`);
        // Units to the nanocoin: summing REAL units leaves float dust (≈1e-17) after a sell-all.
        const units = Math.round(cryptoCoinCumulativeThroughDate(id, v.as_of_date) * 1e9) / 1e9;
        restamp.run(Math.round(value * 100) / 100, units, v.id);
        restamped += 1;
      }
    }
  }).immediate();
  console.log(`\nApplied: deleted ${toDelete.length} sheet rows, inserted ${planned.length} rebuilt rows, re-stamped ${restamped} valuation rows.`);
}

main();
