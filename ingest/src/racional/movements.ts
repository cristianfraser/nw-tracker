import type { BrokerDividend, BrokerMovement } from "nw-tracker-contracts";

/**
 * Racional movement rows (as the crawl stages them) → canonical `broker.movements` movements.
 *
 * Racional's movements are not served by a REST call — they arrive over a Firestore realtime
 * channel — so the crawl reads the rendered list and, for each row, the detail view. This
 * module is the decoding half: raw strings in, canonical records out; the server plans them.
 *
 * Shapes verified against the live app on 2026-08-05 (see `ingest/src/racional/routes.ts`):
 *   list row  : "Compra SLV" · "US$x.xxx,xx" · "01/07"
 *   detail    : "Recibiste 24,74186066 acciones de Silver Trust (SLV), a un valor de
 *                US$xx,xx por acción." + "Comisión US$x,xx" + "Orden #86365B402E0D"
 *   identity  : /movements/<uid>_2026-07-01T16:47:2x.xxxZ_1346.17?type=…&status=complete
 *
 * The identity's ISO timestamp is the authoritative date: the printed "01/07" carries no year.
 */

/** Racional's own taxonomy, from the «Movimientos» filter chips. */
export type RacionalMovementKind =
  | "deposit"
  | "withdrawal"
  | "buy"
  | "sell"
  | "dividend"
  | "interest"
  | "fee"
  | "corporate_action"
  /** A managed portfolio's caja returned to the wallet when the portfolio is liquidated. */
  | "portfolio_cash_withdrawal";

export type RacionalScrapedRow = {
  /** e.g. "Compra SLV", "Depósito", "Dividendo". */
  title: string;
  /** As printed: "US$x.xxx,xx" or "$3.xxx.xxx". */
  amount: string;
  /** Printed day, "dd/mm" — stands in for `occurred_on` in the list key when the year is unknown. */
  day?: string | null;
  /**
   * `YYYY-MM-DD` from the list (the printed day joined to its «Año NNNN» separator). Preferred
   * over the id's timestamp because it exists for every row, including the ones the crawl
   * never opened — Racional's rows carry no href, so an id costs a click.
   */
  occurred_on?: string | null;
  /**
   * `.movement-type` class (`buy`, `contribution`, `dividends`, `withdrawal`) — language-independent.
   * A row still in flight carries the state as a prefix (`pending-withdrawal` while a Retiro's
   * money has not reached the wallet), which the list key strips: the state changes, the row does not.
   */
  kind_class?: string | null;
  /** The row's state as the crawl read it (since 2026-10-21): `pending` from a `pending-` class, else `complete`. */
  status?: "pending" | "complete" | null;
  /** Canonical id from the detail route; only known for rows the crawl opened. */
  movement_id?: string | null;
  /** Raw text of the detail panel, when the fetcher opened it. */
  detail?: string | null;
  /**
   * Set by the crawl (since 2026-09-27) on every row that needed its detail view — a trade, or
   * a dividend no API record covered: `opened` when the route id and the detail text were read,
   * `unopened` when the row could not be reached (`detail_error` says why). Absent on cash
   * rows, on API-matched dividends and in files staged before the flag existed.
   */
  detail_status?: "opened" | "unopened" | null;
  /** Why the crawl could not open the row's detail view. */
  detail_error?: string | null;
  /**
   * The dividend's own record from Racional's `/users/movements/dividends` API, matched to the
   * list row by day and net amount at crawl time (since 2026-09-23). Carries what the list row
   * never shows: the paying instrument, and the gross / withholding behind the credited net.
   */
  dividend?: RacionalScrapedDividend | null;
};

/**
 * One entry of Racional's dividends API, normalized.
 *
 * Verified live 2026-09-21: `{ id: "div_NI.<uuid>_SOXX_<ISO>", assetId: "SOXX", DIV: 2.75,
 * DIVTAX: -0.41, amount: 2.34, amountUSD: 2.34, executionDate, isInterest, isRebateInterest,
 * isUSDDividend, … }` — `DIV` is the gross dividend, `DIVTAX` the (negative) US withholding,
 * `amount` the net the wallet received. The list row prints the net.
 */
export type RacionalScrapedDividend = BrokerDividend;

function finiteNumber(value: unknown, field: string, id: string): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`Racional dividends API: entry ${id} has no numeric ${field} (got ${JSON.stringify(value)})`);
  }
  return n;
}

/**
 * Parse the raw `/users/movements/dividends` response (`{ dividends: [...] }`).
 *
 * Fail-fast on any shape change: the breakdown feeds the tax record, so an entry with a missing
 * field must surface as a failed step, never as a dividend silently imported without its tax.
 * A non-USD dividend is unmapped (the ledger's Racional cash side is USD) and throws too.
 */
export function racionalApiDividendsFromResponse(body: unknown): RacionalScrapedDividend[] {
  const list = (body as { dividends?: unknown } | null)?.dividends;
  if (!Array.isArray(list)) {
    throw new Error("Racional dividends API: response has no `dividends` array — the endpoint shape changed");
  }
  return list.map((raw) => {
    const entry = raw as Record<string, unknown>;
    const id = String(entry.id ?? "").trim();
    if (!id) throw new Error("Racional dividends API: entry without an id");
    const assetId = String(entry.assetId ?? "").trim().toUpperCase();
    if (!assetId) throw new Error(`Racional dividends API: entry ${id} has no assetId`);
    if (entry.isUSDDividend !== true) {
      throw new Error(`Racional dividends API: entry ${id} is not a USD dividend — map its currency before importing`);
    }
    const executionDate = String(entry.executionDate ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(executionDate)) {
      throw new Error(`Racional dividends API: entry ${id} has no ISO executionDate (got ${JSON.stringify(entry.executionDate)})`);
    }
    const gross = finiteNumber(entry.DIV, "DIV", id);
    const withholding = -finiteNumber(entry.DIVTAX, "DIVTAX", id);
    const net = finiteNumber(entry.amount, "amount", id);
    if (withholding < -0.005) {
      throw new Error(`Racional dividends API: entry ${id} has a positive DIVTAX (${entry.DIVTAX}) — a refund is unmapped`);
    }
    if (Math.abs(gross - withholding - net) > 0.015) {
      throw new Error(
        `Racional dividends API: entry ${id} does not add up (DIV ${gross} + DIVTAX ${-withholding} ≠ amount ${net})`
      );
    }
    return {
      id,
      asset_id: assetId,
      gross,
      withholding: Math.max(0, withholding),
      net,
      execution_date: executionDate,
      is_interest: entry.isInterest === true || entry.isRebateInterest === true,
    };
  });
}

/**
 * `.movement-type` class → kind. Verified live for these three; anything else falls back to the
 * printed label, which then throws if it is also unknown.
 */
const KIND_BY_CLASS: Record<string, RacionalMovementKind> = {
  buy: "buy",
  sell: "sell",
  contribution: "deposit",
  dividends: "dividend",
  withdrawal: "withdrawal",
  commissions: "fee",
};

/** The `pending-` state prefix a `.movement-type` class carries while the row is in flight. */
const RE_PENDING_CLASS = /^pending-/i;

/**
 * A row's `.movement-type` class without its state: `pending-withdrawal` → `withdrawal`. The
 * 2026-10-20 portfolio liquidation listed as `pending-withdrawal` the night it was requested and
 * reads `withdrawal` once the money lands two days later — the same row, so the key and the kind
 * must read the same both nights.
 */
export function racionalRowKindClass(kindClass: string | null | undefined): string | null {
  const cls = String(kindClass ?? "").trim().toLowerCase().replace(RE_PENDING_CLASS, "");
  return cls || null;
}

/** A decoded row: the canonical movement the server receives. */
export type RacionalMovement = BrokerMovement;

const KIND_BY_PREFIX: [RegExp, RacionalMovementKind][] = [
  [/^dep[óo]sito/i, "deposit"],
  [/^retiro/i, "withdrawal"],
  [/^compra\b/i, "buy"],
  [/^venta\b/i, "sell"],
  [/^dividendo/i, "dividend"],
  [/^inter[ée]s|^intereses/i, "interest"],
  [/^comisi[óo]n/i, "fee"],
  [/^evento\s+corporativo/i, "corporate_action"],
];

export function racionalMovementKind(title: string): RacionalMovementKind {
  const t = String(title ?? "").trim();
  for (const [re, kind] of KIND_BY_PREFIX) {
    if (re.test(t)) return kind;
  }
  throw new Error(
    `Unmapped Racional movement kind "${title}" — extend KIND_BY_PREFIX rather than guessing ` +
      `(an unknown kind has an unknown cash direction)`
  );
}

/** "Compra SLV" → "SLV". Cash movements carry no symbol. */
export function racionalMovementTicker(title: string): string | null {
  const m = /^(?:compra|venta)\s+(.+)$/i.exec(String(title ?? "").trim());
  const symbol = m?.[1]?.trim();
  return symbol ? symbol.toUpperCase() : null;
}

/**
 * "US$x.xxx,xx" → { usd, 1346.17 }; "$3.xxx.xxx" → { clp, 3000000 }.
 *
 * Chilean formatting: dots group thousands, the comma is the decimal separator. A bare `$` is
 * CLP and `US$` is dollars — mixing them up is a ~900× error, so the prefix is required rather
 * than inferred from magnitude.
 */
export function parseRacionalAmount(raw: string): { amount: number; currency: "clp" | "usd" } {
  const text = String(raw ?? "").trim();
  const m = /^(US\$|\$)\s*(-?[\d.]+(?:,\d+)?)$/i.exec(text);
  if (!m) throw new Error(`Unexpected Racional amount "${raw}" (want "$1.234" or "US$1.234,56")`);
  const currency = /^US\$/i.test(m[1]!) ? "usd" : "clp";
  const numeric = Number(m[2]!.replace(/\./g, "").replace(",", "."));
  if (!Number.isFinite(numeric)) throw new Error(`Unparseable Racional amount "${raw}"`);
  return { amount: numeric, currency };
}

/**
 * The ISO timestamp inside a movement id. Two shapes exist, both verified live:
 *   trade    `<uid>_2026-07-01T16:47:2x.xxxZ_1346.17`            (route /movements/…)
 *   dividend `div_NF.<uuid>_VEA_2026-06-23T10:44:1x.xxxZ`        (route /movements/passive/…)
 * so the timestamp is followed by an underscore in one and ends the id in the other.
 */
export function racionalMovementTimestamp(movementId: string): string {
  const m = /_(\d{4}-\d{2}-\d{2}T[\d:.]+Z)(?:_|$)/.exec(String(movementId ?? ""));
  if (!m) {
    throw new Error(
      `Racional movement id "${movementId}" has no ISO timestamp — the detail route shape changed`
    );
  }
  return m[1]!;
}

/**
 * Paying instrument for a dividend, taken from its id (`…_VEA_<ISO>`).
 *
 * The list row is only ever "Dividendo", so without this the instrument would have to come
 * from the detail view — the id carries it, which saves a navigation per dividend and removes
 * any chance of attributing a payout to the wrong holding.
 */
export function racionalDividendTickerFromId(movementId: string): string | null {
  const m = /_([A-Z][A-Z0-9.]{0,9})_\d{4}-\d{2}-\d{2}T/.exec(String(movementId ?? ""));
  return m ? m[1]!.toUpperCase() : null;
}

const RE_DETAIL_UNITS =
  /Recibiste\s+([\d.,]+)\s+acciones\s+de\s+.+?\((\w[\w.]*)\)\s*,\s*a un valor de\s+US\$([\d.,]+)\s+por acci[óo]n/i;
const RE_DETAIL_ORDER_ID = /Orden[\s|]+#([A-Z0-9]+)/i;
// Label and value are separate DOM nodes, so what sits between them is a newline in raw
// innerText and a pipe once flattened — accept either rather than depending on the caller.
const RE_DETAIL_COMMISSION = /Comisi[óo]n[\s|]+US\$([\d.,]+)/i;

/** Chilean decimal string → plain decimal string (no float round-trip for 8-decimal units). */
function chileanDecimalString(raw: string): string {
  return String(raw ?? "").replace(/\./g, "").replace(",", ".");
}

export type RacionalDetailFields = {
  units: string | null;
  price: number | null;
  commission: number | null;
  order_id: string | null;
  detail_ticker: string | null;
};

export function parseRacionalDetail(detail: string | null | undefined): RacionalDetailFields {
  const text = String(detail ?? "");
  const units = RE_DETAIL_UNITS.exec(text);
  const commission = RE_DETAIL_COMMISSION.exec(text);
  const order = RE_DETAIL_ORDER_ID.exec(text);
  return {
    units: units ? chileanDecimalString(units[1]!) : null,
    price: units ? Number(chileanDecimalString(units[3]!)) : null,
    commission: commission ? Number(chileanDecimalString(commission[1]!)) : null,
    order_id: order ? order[1]! : null,
    detail_ticker: units ? units[2]!.toUpperCase() : null,
  };
}

/**
 * The row's identity as the crawl sees it in the rendered list, before any detail route is
 * known: `<YYYY-MM-DD or dd/mm>|<movement-type class or title>|<printed amount>`, e.g.
 * `2026-09-22|buy|US$xxx,xx`. The crawl cursor (`crawlCursor.ts`) holds the key of the first row
 * of the newest read the server applied, and the crawl stops at the rendered row with the same
 * key (`rowKey` in steps.ts is this function). Until 2026-09-27 the crawl compared this key with
 * a route id, which never matched — every crawl walked the whole rendered window as «new».
 */
export function racionalListRowKey(row: RacionalScrapedRow): string {
  if ((row.occurred_on ?? row.day) == null) {
    throw new Error(`Racional row "${row.title}" (${row.amount}) has no list identity — neither occurred_on nor day`);
  }
  // The class without its `pending-` state: a Retiro keyed `pending-withdrawal` the night it was
  // requested is the same row as the `withdrawal` it reads once paid.
  return `${row.occurred_on ?? row.day}|${racionalRowKindClass(row.kind_class) ?? row.title}|${row.amount}`;
}

/**
 * A stored list key in the form {@link racionalListRowKey} builds today. The crawl cursor written
 * on 2026-10-21 holds `2026-10-20|pending-withdrawal|$1.234.567` (keys carried the state until then);
 * compared normalized, it is reached when the row reads `withdrawal` — a cursor the crawl cannot find
 * re-stages the whole rendered window, which the importer dedupes but which should never be by accident.
 */
export function normalizeRacionalListRowKey(key: string): string {
  return String(key ?? "").replace(/^([^|]*)\|pending-/i, "$1|");
}

/** What keeps a movement from being written as it stands (see `RacionalMovement.incomplete`). */
function incompleteReason(
  kind: RacionalMovementKind,
  row: RacionalScrapedRow,
  detail: RacionalDetailFields,
  ticker: string | null
): string | null {
  const unopened =
    row.detail_status === "unopened"
      ? `the crawl could not open its detail view (${row.detail_error ?? "no reason recorded"})`
      : null;
  if (kind === "buy" || kind === "sell") {
    const unknown = [!detail.units ? "share count" : null, !ticker ? "instrument" : null].filter(
      (s): s is string => s != null
    );
    if (unknown.length === 0) return null;
    const why = unopened ?? (row.detail ? "its detail view printed no fill" : "the crawl never opened its detail view");
    return `${unknown.join(" and ")} unknown — ${why}`;
  }
  if (kind === "dividend" && !ticker) {
    return `paying instrument unknown — ${unopened ?? "no dividends-API record matched the row and no route id names one"}`;
  }
  // A «Retiro» is either cash sent to a bank or a portfolio liquidated into the wallet, and only
  // its detail view says which (since 2026-10-21 the crawl opens it): without one the row cannot
  // be set aside as a bank withdrawal, which is how the 2026-10-20 liquidation was lost.
  if (kind === "withdrawal" && !row.detail) {
    return `whether it liquidated a portfolio or paid a bank account unknown — ${
      unopened ?? "the crawl never opened its detail view"
    }`;
  }
  return null;
}

/**
 * Build one typed movement.
 *
 * A trade without units is never WRITTEN: importing a buy with no share count would move cash
 * and silently leave the position short, which is exactly the class of error the CC work spent
 * the day chasing. It is not rejected here either: the crawl lists every row it saw, opened or
 * not, and a trade the ledger already holds (the mail path books Racional buys with their units
 * before the nightly crawl) needs nothing from its detail view. So the gap is recorded as
 * `incomplete` and the importer decides — already in the ledger → nothing to do, would be
 * written → the file fails. Throwing here instead (until 2026-09-27) let one unopened row that
 * was long since movement 11110 fail every staged file behind it, night after night.
 */
export function racionalRowToMovement(row: RacionalScrapedRow): RacionalMovement {
  const [movement, ...rest] = racionalRowToMovements(row);
  if (rest.length > 0) {
    throw new Error(`Racional row "${row.title}" (${row.amount}) decodes to ${rest.length + 1} movements — use racionalRowToMovements`);
  }
  return movement!;
}

/**
 * Every movement a row describes: one for most rows; for a «Retiro» that liquidated a managed
 * portfolio (its detail view prints «Montos vendidos»), one `sell` per position sold plus the
 * caja's pesos as a `portfolio_cash_withdrawal` — the mirror of how the portfolio was bought
 * (a `stock_buy` into the ETF plus a transfer into the caja). A Retiro whose detail names no sold
 * amounts stays the cash withdrawal it always was.
 */
export function racionalRowToMovements(row: RacionalScrapedRow): RacionalMovement[] {
  const single = decodeRacionalRow(row);
  if (single.kind !== "withdrawal") return [single];
  const liquidation = parseRacionalLiquidationDetail(row.detail);
  if (!liquidation) return [single];
  if (single.currency !== "clp") {
    throw new Error(`Racional liquidation "${row.title}" (${row.amount}) is listed in ${single.currency} — only CLP portfolios are mapped`);
  }
  const day = liquidation.sale_day ?? single.occurred_on;
  const occurredAt = day === single.occurred_on ? single.occurred_at : `${day}T00:00:00.000Z`;
  const sells: RacionalMovement[] = liquidation.positions.map((p) => ({
    ...single,
    movement_id: `${single.movement_id}#sell:${p.ticker}`,
    kind: "sell",
    ticker: p.ticker,
    occurred_on: day,
    occurred_at: occurredAt,
    amount: p.amount,
    units: p.units,
    price: p.price,
    title: `${single.title} · venta ${p.ticker}`,
    incomplete: null,
  }));
  // A portfolio whose caja held nothing prints no «Además, se retiraron…» line: nothing to move.
  const caja: RacionalMovement[] =
    liquidation.caja_amount > 0
      ? [
          {
            ...single,
            movement_id: `${single.movement_id}#caja`,
            kind: "portfolio_cash_withdrawal",
            ticker: null,
            occurred_on: day,
            occurred_at: occurredAt,
            amount: liquidation.caja_amount,
            title: `${single.title} · caja`,
            incomplete: null,
          },
        ]
      : [];
  return [...sells, ...caja];
}

/** One position the liquidation detail prints under «Montos vendidos». */
export type RacionalLiquidationPosition = {
  ticker: string;
  /** Pesos per share, as printed. */
  price: number;
  /** Pesos the sale brought, as printed. */
  amount: number;
  /** Shares sold, as a decimal string. */
  units: string;
};

export type RacionalLiquidationDetail = {
  positions: RacionalLiquidationPosition[];
  /** «Además, se retiraron $X de lo que tenías de caja» — 0 when the line is absent. */
  caja_amount: number;
  /** The day the sale step of the detail's timeline prints, or null when it prints none. */
  sale_day: string | null;
};

const RE_SOLD_SECTION = /Montos\s+vendidos/i;
// Name, ticker, price, pesos, share count — each in its own node, so separated by newlines in
// raw innerText and by pipes once flattened; the ticker is the last bare symbol before the price.
const RE_SOLD_POSITION =
  /\b([A-Z][A-Z0-9.]{1,9})[\s|,·…]*\$\s*([\d.]+(?:,\d+)?)[\s|,·…]*\$\s*([\d.]+(?:,\d+)?)[\s|,·…]*([\d.]+(?:,\d+)?)\s+acciones?\b/g;
const RE_CAJA_LINE = /se\s+retir(?:aron|ó)\s+\$\s*([\d.]+(?:,\d+)?)\s+de\s+lo\s+que\s+ten[íi]as\s+(?:de|en)\s+caja/i;
// The timeline step that sold the positions («Venta de activos | Completada | 20/10/26 15:31»):
// the first dd/mm/yy within reach of a label naming the sale.
const RE_SALE_STEP = /\b(?:venta|vendid[oa]s?)\b[\s\S]{0,80}?\b(\d{2})\/(\d{2})\/(\d{2})\b/i;

/**
 * The liquidation a Retiro's detail view describes, or null when it describes a plain cash
 * withdrawal (no «Montos vendidos» section). A section with no readable position throws: the
 * layout changed, and the row must not quietly become a bank withdrawal again.
 */
export function parseRacionalLiquidationDetail(detail: string | null | undefined): RacionalLiquidationDetail | null {
  const text = String(detail ?? "");
  const section = RE_SOLD_SECTION.exec(text);
  if (!section) return null;
  const sold = text.slice(section.index + section[0].length);
  const positions: RacionalLiquidationPosition[] = [];
  for (const m of sold.matchAll(RE_SOLD_POSITION)) {
    const ticker = m[1]!.toUpperCase();
    if (positions.some((p) => p.ticker === ticker)) {
      throw new Error(`Racional liquidation detail lists ${ticker} twice under «Montos vendidos»`);
    }
    positions.push({
      ticker,
      price: Number(chileanDecimalString(m[2]!)),
      amount: Number(chileanDecimalString(m[3]!)),
      units: chileanDecimalString(m[4]!),
    });
  }
  if (positions.length === 0) {
    throw new Error("Racional liquidation detail has a «Montos vendidos» section but no readable position (ticker, $price, $pesos, N acciones) — the layout changed");
  }
  for (const p of positions) {
    if (!(p.price > 0) || !(p.amount > 0) || !(Number(p.units) > 0)) {
      throw new Error(`Racional liquidation detail: ${p.ticker} sold at $${p.price} for $${p.amount}, ${p.units} shares — not a sale`);
    }
  }
  const caja = RE_CAJA_LINE.exec(text);
  const cajaAmount = caja ? Number(chileanDecimalString(caja[1]!)) : 0;
  if (!Number.isFinite(cajaAmount) || cajaAmount < 0) {
    throw new Error(`Racional liquidation detail: unreadable caja amount "${caja?.[1]}"`);
  }
  const step = RE_SALE_STEP.exec(text.slice(0, section.index));
  const saleDay = step ? `20${step[3]}-${step[2]}-${step[1]}` : null;
  return { positions, caja_amount: cajaAmount, sale_day: saleDay };
}

function decodeRacionalRow(row: RacionalScrapedRow): RacionalMovement {
  const dividend = row.dividend ?? null;
  const movementId = String(row.movement_id ?? dividend?.id ?? "").trim();
  const listDate = String(row.occurred_on ?? "").trim();
  if (!movementId && !listDate) {
    throw new Error(`Racional row "${row.title}" has neither a date nor a movement id`);
  }
  if (row.detail_status === "unopened" && row.detail) {
    throw new Error(`Racional row "${row.title}" (${row.amount}) is flagged unopened but carries a detail text — the crawl output is inconsistent`);
  }
  const kindClass = racionalRowKindClass(row.kind_class) ?? "";
  const kind = KIND_BY_CLASS[kindClass] ?? racionalMovementKind(row.title);
  const { amount, currency } = parseRacionalAmount(row.amount);
  if (dividend && kind !== "dividend") {
    throw new Error(`Racional row "${row.title}" carries a dividend record but is a ${kind}`);
  }
  if (dividend && (currency !== "usd" || Math.abs(dividend.net - amount) > 0.005)) {
    throw new Error(
      `Racional dividend row "${row.title}" prints ${amount} ${currency} but its API record ${dividend.id} ` +
        `credited ${dividend.net} usd — the crawl matched the wrong record`
    );
  }
  // The list date covers every row; the id's timestamp adds the time, for rows that have one.
  const occurredAt = movementId
    ? racionalMovementTimestamp(movementId)
    : `${listDate}T00:00:00.000Z`;
  const detail = parseRacionalDetail(row.detail);
  const ticker =
    racionalMovementTicker(row.title) ??
    detail.detail_ticker ??
    (kind === "dividend" ? dividend?.asset_id ?? racionalDividendTickerFromId(movementId) : null);

  if (detail.detail_ticker && ticker && detail.detail_ticker !== ticker) {
    throw new Error(
      `Racional movement "${row.title}" ticker mismatch: list says ${ticker}, detail says ${detail.detail_ticker}`
    );
  }

  return {
    // Rows the crawl never opened have no canonical id; a synthetic identity stands in. It is
    // provenance only — the crawl watermark is the list key (`racionalListRowKey`).
    movement_id: movementId || `${occurredAt.slice(0, 10)}|${kind}|${amount}`,
    kind,
    ticker,
    occurred_on: occurredAt.slice(0, 10),
    occurred_at: occurredAt,
    amount,
    currency,
    units: detail.units,
    price: detail.price,
    commission: detail.commission,
    order_id: detail.order_id,
    title: String(row.title ?? "").trim(),
    dividend,
    incomplete: incompleteReason(kind, row, detail, ticker),
  };
}

/** Newest first, matching the app's own ordering (the incremental crawl relies on it). */
export function sortRacionalMovementsNewestFirst(
  movements: readonly RacionalMovement[]
): RacionalMovement[] {
  return [...movements].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
