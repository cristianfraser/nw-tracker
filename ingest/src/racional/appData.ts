import { isChileanNumber, parseChileanNumber } from "nw-tracker-contracts";
import type { RacionalLiquidationDetail, RacionalDetailFields, RacionalScrapedDividend, RacionalScrapedRow } from "./movements.js";

/**
 * Racional's app data, as its own server answers it (the app rebuilt in 2026-11).
 *
 * The app calls server functions (`app.racional.cl/_serverFn/<hash>`) whose answers are encoded
 * with seroval: every value is a node `{t, …}` — an object `{t: 10, p: {k: [keys], v: [nodes]}}`,
 * an array `{t: 9, a: [nodes]}`, a string or number `{t: 1 | 0, s}`, a constant `{t: 2, s}`
 * (2 true, 3 false, 0 null, 1 undefined) and a back-reference `{t: 4, i}` to an earlier node with
 * that index. Every answer is `{result, error, context}`. The hashes change with each build of
 * the app, so answers are recognised by their shape, never by URL.
 *
 * Verified live on 2026-11-18 against the movements list (`limit` 100, newest first, a
 * `nextCursor` for older pages) and the detail of a buy, a dividend, a portfolio liquidation and
 * a dollar purchase. The list prints amounts as «USD 1.234,56» / «CLP 1.234.567» (Chilean
 * separators) and dates as ISO instants; a row's detail is a second answer keyed by its id.
 */

type SerovalNode = { t?: unknown; i?: unknown; s?: unknown; a?: unknown; p?: { k?: unknown; v?: unknown } };

/** A seroval-encoded value → plain JSON. An unknown node type throws: guessing would lose a field. */
export function decodeSeroval(node: unknown): unknown {
  const refs = new Map<number, unknown>();
  const walk = (raw: unknown): unknown => {
    if (raw == null) return null;
    const n = raw as SerovalNode;
    switch (n.t) {
      case 10:
      case 11: {
        const keys = n.p?.k;
        const values = n.p?.v;
        if (!Array.isArray(keys) || !Array.isArray(values) || keys.length !== values.length) {
          throw new Error("racional: malformed object node in a server answer");
        }
        const out: Record<string, unknown> = {};
        if (typeof n.i === "number") refs.set(n.i, out);
        keys.forEach((k, idx) => {
          out[String(k)] = walk(values[idx]);
        });
        return out;
      }
      case 9: {
        if (!Array.isArray(n.a)) throw new Error("racional: malformed array node in a server answer");
        const out: unknown[] = [];
        if (typeof n.i === "number") refs.set(n.i, out);
        for (const item of n.a) out.push(walk(item));
        return out;
      }
      case 0:
      case 1:
        return n.s;
      case 2:
        if (n.s === 2) return true;
        if (n.s === 3) return false;
        if (n.s === 0 || n.s === 1) return null;
        throw new Error(`racional: unknown constant ${String(n.s)} in a server answer`);
      case 4:
        if (typeof n.i !== "number" || !refs.has(n.i)) throw new Error(`racional: dangling reference ${String(n.i)} in a server answer`);
        return refs.get(n.i);
      default:
        throw new Error(`racional: unknown node type ${String(n.t)} in a server answer`);
    }
  };
  return walk(node);
}

/** The `result` of a server answer (`{result, error, context}`), or null when the body is not one or carries an error. */
export function serverFnResult(body: unknown): Record<string, unknown> | null {
  if (body == null || typeof body !== "object" || (body as SerovalNode).t == null) return null;
  const decoded = decodeSeroval(body) as Record<string, unknown> | null;
  if (decoded == null || typeof decoded !== "object" || !("result" in decoded)) return null;
  if (decoded.error != null) return null;
  const result = decoded.result;
  return result != null && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : null;
}

/** One row of the movements list, as the app's server answers it. */
export type RacionalApiListRow = {
  id: string;
  /** `stock_buy`, `dividend`, `deposit`, `usd_deposit`, `withdrawal`, `commission`, `corporate_action_split`, … */
  type: string;
  status: string;
  label: string;
  /** «USD 2,01» / «CLP 3.039.518», as listed. */
  amount: string;
  currency: string;
  created_at: string;
  asset_id: string | null;
};

export type RacionalApiListPage = { rows: RacionalApiListRow[]; next_cursor: string | null };

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));

/** Whether a server-function result is the movements list (`{userId, data: […], nextCursor}`). */
export function isRacionalMovementsListResult(result: Record<string, unknown> | null): boolean {
  return result != null && Array.isArray(result.data) && "nextCursor" in result && "userId" in result;
}

/** The movements list out of its result. A row without id, type, amount or date throws: the shape changed. */
export function racionalMovementsListPage(result: Record<string, unknown>): RacionalApiListPage {
  if (!isRacionalMovementsListResult(result)) throw new Error("racional: not a movements-list answer");
  const rows = (result.data as unknown[]).map((raw, i): RacionalApiListRow => {
    const r = (raw ?? {}) as Record<string, unknown>;
    const row: RacionalApiListRow = {
      id: str(r.id).trim(),
      type: str(r.type).trim(),
      status: str(r.status).trim(),
      label: str(r.label).trim(),
      amount: str(r.amountFormatted || r.amount).trim(),
      currency: str(r.currency).trim(),
      created_at: str(r.createdAt).trim(),
      asset_id: str(r.assetId).trim() || null,
    };
    if (!row.id || !row.type || !row.amount || !row.created_at || Number.isNaN(Date.parse(row.created_at))) {
      throw new Error(`racional: movements-list row ${i} lacks id, type, amount or date — the answer's shape changed`);
    }
    return row;
  });
  const next = result.nextCursor;
  return { rows, next_cursor: typeof next === "string" && next ? next : null };
}

/**
 * The list's type → the row class the crawl has always keyed rows by (the old app's
 * `.movement-type` class), so a stored crawl cursor still names the same row. An unknown type
 * throws: its cash direction is unknown.
 */
const CLASS_BY_TYPE: Record<string, string> = {
  stock_buy: "buy",
  stock_sell: "sell",
  dividend: "dividends",
  deposit: "contribution",
  // The wallet's dollar purchase («Depósito» in dollars), listed as a contribution by the old app too.
  usd_deposit: "contribution",
  withdrawal: "withdrawal",
  commission: "commissions",
  corporate_action_split: "corporate_action",
};

export function racionalClassOfType(type: string): string {
  const cls = CLASS_BY_TYPE[type];
  if (!cls) {
    throw new Error(`racional: unmapped movement type "${type}" — map it in CLASS_BY_TYPE rather than guessing its cash direction`);
  }
  return cls;
}

/** Rows whose detail the ledger needs: a trade's fill, a dividend's breakdown, what a Retiro sold. */
export function racionalTypeNeedsDetail(type: string): boolean {
  return type === "stock_buy" || type === "stock_sell" || type === "dividend" || type === "withdrawal";
}

/**
 * «USD 1.234,56» → «US$1.234,56», «CLP 1.234.567» → «$1.234.567»: the print the crawl's list key
 * and the amount parser have always read, so keys staged before the rebuild still match.
 */
export function racionalPrintedAmount(listed: string): string {
  const m = /^(USD|CLP)\s*(-?[\d.]+(?:,\d+)?)$/.exec(listed.trim());
  if (!m || !isChileanNumber(m[2]!)) throw new Error(`racional: unexpected listed amount "${listed}" (want «USD 1.234,56» or «CLP 1.234»)`);
  return `${m[1] === "USD" ? "US$" : "$"}${m[2]}`;
}

/** The Chile calendar day of an ISO instant — the day the app prints. */
export function chileDayOfInstant(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`racional: unreadable instant "${iso}"`);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Santiago" });
}

/** A list row as the crawl stages it (details are added by the parsers below). */
export function stagedRowFromListRow(row: RacionalApiListRow): RacionalScrapedRow {
  const day = chileDayOfInstant(row.created_at);
  return {
    title: row.label,
    amount: racionalPrintedAmount(row.amount),
    day: `${day.slice(8, 10)}/${day.slice(5, 7)}`,
    occurred_on: day,
    kind_class: racionalClassOfType(row.type),
    status: row.status === "complete" ? "complete" : "pending",
    movement_id: row.id,
    created_at: row.created_at,
    api_type: row.type,
  };
}

/** «USD 123,45» / «CLP 1.234,50» → the number; anything else throws. */
// convention-ok: Racional lists amounts in pesos or dollars only («USD …» / «CLP …»)
function listedNumber(text: string, currency: string, what: string): number {
  const m = new RegExp(`^${currency}\\s*(-?[\\d.]+(?:,\\d+)?)$`).exec(text.trim());
  if (!m || !isChileanNumber(m[1]!)) throw new Error(`racional: ${what} "${text}" is not a ${currency} amount`);
  return parseChileanNumber(m[1]!);
}

/** «6,20948563» → "6.20948563" (no float round-trip for 8-decimal share counts). */
function decimalString(text: string, what: string): string {
  const t = text.trim();
  if (!isChileanNumber(t)) throw new Error(`racional: ${what} "${text}" is not a number`);
  return t.replace(/\./g, "").replace(",", ".");
}

/** «22/10/2026 10:38» → "2026-10-22". */
function dayOfPrintedStamp(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\b/.exec(text.trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

function assertDetailFor(result: Record<string, unknown>, id: string): void {
  const own = str(result.movementId || result.id).trim();
  if (own !== id) throw new Error(`racional: the detail answer is for "${own}", not "${id}"`);
}

/** Whether a server-function result is the detail of movement `id`. */
export function isRacionalDetailResultFor(result: Record<string, unknown> | null, id: string): boolean {
  return result != null && str(result.movementId || result.id).trim() === id;
}

/**
 * A trade's fill: «Acciones», «Precio ejecutado», «Comisión», «Número de orden» from the detail's
 * sections. A detail without a share count (an order still in flight) returns null units, which
 * the importer reports as incomplete rather than writing a trade with no shares.
 */
export function racionalTradeFill(result: Record<string, unknown>, id: string): RacionalDetailFields {
  assertDetailFor(result, id);
  const sections = ((result.details as Record<string, unknown> | undefined)?.sections ?? []) as unknown[];
  if (!Array.isArray(sections)) throw new Error(`racional: trade detail ${id} has no sections`);
  const fields = new Map<string, string>();
  for (const section of sections) {
    if (!Array.isArray(section)) throw new Error(`racional: trade detail ${id} has a malformed section`);
    for (const item of section) {
      const f = (item ?? {}) as Record<string, unknown>;
      fields.set(str(f.title).trim().toLowerCase(), str(f.value).trim());
    }
  }
  const units = fields.get("acciones");
  const price = fields.get("precio ejecutado");
  const commission = fields.get("comisión") ?? fields.get("comision");
  const order = fields.get("número de orden") ?? fields.get("numero de orden");
  const ticker = str(result.assetId).trim().toUpperCase() || null;
  return {
    units: units ? decimalString(units, "share count") : null,
    price: price ? listedNumber(price, "USD", "execution price") : null,
    commission: commission ? listedNumber(commission, "USD", "commission") : null,
    order_id: order ? order.replace(/^#/, "") : null,
    detail_ticker: ticker,
  };
}

/** A dividend's own record: the paying instrument and the gross / US withholding behind the credited net. */
export function racionalDividendRecord(result: Record<string, unknown>, id: string): RacionalScrapedDividend {
  assertDetailFor(result, id);
  const num = (v: unknown, what: string): number => {
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`racional: dividend ${id} has no numeric ${what}`);
    return v;
  };
  const gross = num(result.grossAmount, "grossAmount");
  const tax = num(result.taxAmount, "taxAmount");
  const net = num(result.netAmount, "netAmount");
  if (Math.abs(gross + tax - net) > 0.005) {
    throw new Error(`racional: dividend ${id} prints gross ${gross} and tax ${tax} but net ${net}`);
  }
  const asset = str(result.assetId).trim().toUpperCase();
  if (!asset) throw new Error(`racional: dividend ${id} names no instrument`);
  return {
    id,
    asset_id: asset,
    gross,
    withholding: Math.abs(tax),
    net,
    execution_date: str(result.createdAt).trim(),
    is_interest: false,
  };
}

/**
 * What a «Retiro» did. A managed portfolio liquidated into the wallet (`type: portfolio_sell`)
 * prints the positions sold («Montos vendidos»: ticker, shares, price and pesos) and the caja
 * returned beside them; the sale day is the «Acciones vendidas» step of its progress. Any other
 * Retiro is cash sent to a bank: null. A liquidation without a readable position throws, so it
 * never quietly becomes a bank withdrawal.
 */
export function racionalWithdrawalLiquidation(result: Record<string, unknown>, id: string): RacionalLiquidationDetail | null {
  assertDetailFor(result, id);
  const portfolio = result.portfolioData as Record<string, unknown> | undefined;
  if (str(result.type) !== "portfolio_sell") {
    if (portfolio != null) throw new Error(`racional: Retiro ${id} carries portfolio data but is a "${str(result.type)}"`);
    return null;
  }
  const assets = portfolio?.estimatedAssets;
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error(`racional: portfolio liquidation ${id} lists no positions sold`);
  }
  const positions = assets.map((raw) => {
    const a = (raw ?? {}) as Record<string, unknown>;
    const ticker = str(a.assetId).trim().toUpperCase();
    const position = {
      ticker,
      price: listedNumber(str(a.sharePriceFormatted), "CLP", `${ticker} price`),
      amount: listedNumber(str(a.amount), "CLP", `${ticker} pesos`),
      units: decimalString(str(a.shares), `${ticker} shares`),
    };
    if (!ticker || !(position.price > 0) || !(position.amount > 0) || !(Number(position.units) > 0)) {
      throw new Error(`racional: portfolio liquidation ${id} lists an unreadable position (${JSON.stringify(a)})`);
    }
    return position;
  });
  if (new Set(positions.map((p) => p.ticker)).size !== positions.length) {
    throw new Error(`racional: portfolio liquidation ${id} lists a position twice`);
  }
  const cajaText = str(portfolio?.cashRemainder).trim();
  const caja = cajaText ? listedNumber(cajaText, "CLP", "caja") : 0;
  const steps = Array.isArray(result.progress) ? (result.progress as Record<string, unknown>[]) : [];
  const sold = steps.find((s) => str(s?.type) === "portfolio_sold");
  return { positions, caja_amount: caja, sale_day: sold ? dayOfPrintedStamp(str(sold.date)) : null };
}
