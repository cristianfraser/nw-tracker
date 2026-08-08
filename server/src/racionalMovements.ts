/**
 * Racional movement rows (scraped by `scraper/`) → typed movements.
 *
 * Racional's movements are not served by a REST call — they arrive over a Firestore realtime
 * channel — so the fetcher reads the rendered list and, for each row, the detail view. This
 * module is the pure half: raw strings in, typed records out, no DB.
 *
 * Shapes verified against the live app on 2026-08-05 (see `scraper/src/racional/routes.ts`):
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
  | "corporate_action";

export type RacionalScrapedRow = {
  /** e.g. "Compra SLV", "Depósito", "Dividendo". */
  title: string;
  /** As printed: "US$x.xxx,xx" or "$3.xxx.xxx". */
  amount: string;
  /**
   * `YYYY-MM-DD` from the list (the printed day joined to its «Año NNNN» separator). Preferred
   * over the id's timestamp because it exists for every row, including the ones the crawl
   * never opened — Racional's rows carry no href, so an id costs a click.
   */
  occurred_on?: string | null;
  /** `.movement-type` class (`buy`, `contribution`, `dividends`) — language-independent. */
  kind_class?: string | null;
  /** Canonical id from the detail route; only known for rows the crawl opened. */
  movement_id?: string | null;
  /** Raw text of the detail panel, when the fetcher opened it. */
  detail?: string | null;
};

/**
 * `.movement-type` class → kind. Verified live for these three; anything else falls back to the
 * printed label, which then throws if it is also unknown.
 */
const KIND_BY_CLASS: Record<string, RacionalMovementKind> = {
  buy: "buy",
  sell: "sell",
  contribution: "deposit",
  dividends: "dividend",
};

export type RacionalMovement = {
  movement_id: string;
  kind: RacionalMovementKind;
  /** Instrument symbol for trades/dividends; null for cash movements. */
  ticker: string | null;
  occurred_on: string;
  /** Settlement timestamp, ISO with time — the ordering key for incremental crawls. */
  occurred_at: string;
  amount: number;
  currency: "clp" | "usd";
  /** Shares, as a decimal string so 8-decimal quantities never round-trip through a float. */
  units: string | null;
  price: number | null;
  commission: number | null;
  order_id: string | null;
  raw_title: string;
};

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
 * Build one typed movement.
 *
 * A trade without units is rejected: importing a buy with no share count would move cash and
 * silently leave the position short, which is exactly the class of error the CC work spent the
 * day chasing. Better to fail and re-fetch the detail.
 */
export function racionalRowToMovement(row: RacionalScrapedRow): RacionalMovement {
  const movementId = String(row.movement_id ?? "").trim();
  const listDate = String(row.occurred_on ?? "").trim();
  if (!movementId && !listDate) {
    throw new Error(`Racional row "${row.title}" has neither a date nor a movement id`);
  }
  const kindClass = String(row.kind_class ?? "").trim().toLowerCase();
  const kind = KIND_BY_CLASS[kindClass] ?? racionalMovementKind(row.title);
  const { amount, currency } = parseRacionalAmount(row.amount);
  // The list date covers every row; the id's timestamp adds the time, for rows that have one.
  const occurredAt = movementId
    ? racionalMovementTimestamp(movementId)
    : `${listDate}T00:00:00.000Z`;
  const detail = parseRacionalDetail(row.detail);
  const ticker =
    racionalMovementTicker(row.title) ??
    detail.detail_ticker ??
    (kind === "dividend" ? racionalDividendTickerFromId(movementId) : null);

  if ((kind === "buy" || kind === "sell") && (!detail.units || !ticker)) {
    throw new Error(
      `Racional ${kind} "${row.title}" (${occurredAt}) is missing units or ticker — ` +
        `open its detail view and re-fetch before importing`
    );
  }
  if (detail.detail_ticker && ticker && detail.detail_ticker !== ticker) {
    throw new Error(
      `Racional movement "${row.title}" ticker mismatch: list says ${ticker}, detail says ${detail.detail_ticker}`
    );
  }

  return {
    // Rows the crawl never opened have no canonical id; the list identity stands in, and it is
    // what the watermark compares against on the next run.
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
    raw_title: String(row.title ?? "").trim(),
  };
}

/** Newest first, matching the app's own ordering (the incremental crawl relies on it). */
export function sortRacionalMovementsNewestFirst(
  movements: readonly RacionalMovement[]
): RacionalMovement[] {
  return [...movements].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
}
