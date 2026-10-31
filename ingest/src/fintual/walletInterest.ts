/**
 * Fintual's dollar wallet cash interest («Ganancia dólares» in the app's activity list), read from
 * the site's own `/gql/` — the `stocksWalletCashInterests` field the wallet's movements page asks
 * for (operation `WalletMovements`, captured 2026-10-30) — with the session cookie the server's
 * evening Fintual poll uses (`FINTUAL_COOKIE` in the root `.env`).
 *
 * A row is `{ id, date, createdAt, amount }`: `date` is the day Fintual credits it (2026-06-30,
 * 2026-10-30, both month-ends), `amount` dollars. No mail announces it; the Alpaca cartola prints
 * it ~10 days later. A changed shape throws: a silently empty list would read as «no interest».
 */
import type { BrokerMovement } from "nw-tracker-contracts";
import { loadRootDotenv } from "../rootDotenv.js";

export const FINTUAL_GQL_URL = "https://fintual.cl/gql/";
const OPERATION = "NwTrackerWalletCashInterests";
const QUERY =
  `query ${OPERATION}($limit: Int!, $offset: Int!) {` +
  ` stocksWalletCashInterests(limit: $limit, offset: $offset) { id date createdAt amount } }`;
const PAGE = 50;
/** Far beyond any account's history (one credit a month); reaching it means paging is broken. */
const MAX_PAGES = 20;

/** Decode one page of `stocksWalletCashInterests` into canonical interest movements. */
export function decodeFintualCashInterests(data: unknown): BrokerMovement[] {
  const rows = (data as { stocksWalletCashInterests?: unknown } | null)?.stocksWalletCashInterests;
  if (!Array.isArray(rows)) throw new Error("Fintual /gql: stocksWalletCashInterests missing or not a list");
  return rows.map((r: unknown) => {
    const { id, date, createdAt, amount } = (r ?? {}) as Record<string, unknown>;
    if (typeof id !== "string" || !id) throw new Error(`Fintual cash interest without an id: ${JSON.stringify(r)}`);
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error(`Fintual cash interest ${id}: date ${JSON.stringify(date)}`);
    }
    if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
      throw new Error(`Fintual cash interest ${id}: createdAt ${JSON.stringify(createdAt)}`);
    }
    if (typeof amount !== "number" || !(amount > 0)) throw new Error(`Fintual cash interest ${id}: amount ${JSON.stringify(amount)}`);
    return {
      movement_id: `fintual-cash-interest:${id}`,
      kind: "interest",
      ticker: null,
      occurred_on: date,
      occurred_at: createdAt,
      amount: Math.round(amount * 100) / 100,
      currency: "usd",
      units: null,
      price: null,
      commission: null,
      order_id: null,
      title: "Ganancia dólares",
      dividend: null,
      incomplete: null,
    } satisfies BrokerMovement;
  });
}

function sessionCookie(): string {
  loadRootDotenv();
  const raw = process.env.FINTUAL_COOKIE?.trim().replace(/^["']|["']$/g, "");
  if (!raw) throw new Error("FINTUAL_COOKIE is not set in the root .env (the session cookie the Fintual poll uses)");
  return raw.includes("=") ? raw : `_fintual_session_cookie=${raw}`;
}

async function fetchPage(cookie: string, offset: number): Promise<unknown> {
  const res = await fetch(FINTUAL_GQL_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: "https://fintual.cl",
      Referer: "https://fintual.cl/f/stocks/wallet/movements/",
      Cookie: cookie,
    },
    body: JSON.stringify({ operationName: OPERATION, query: QUERY, variables: { limit: PAGE, offset } }),
  });
  const text = await res.text();
  let body: { data?: unknown; errors?: unknown };
  try {
    body = JSON.parse(text) as typeof body;
  } catch {
    throw new Error(`Fintual /gql ${OPERATION}: non-JSON HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || (Array.isArray(body.errors) && body.errors.length > 0)) {
    throw new Error(`Fintual /gql ${OPERATION}: HTTP ${res.status} ${JSON.stringify(body.errors ?? body).slice(0, 300)}`);
  }
  return body.data;
}

/** Every cash interest credit the wallet has had, newest first as Fintual lists them. */
export async function fetchFintualCashInterests(): Promise<BrokerMovement[]> {
  const cookie = sessionCookie();
  const out: BrokerMovement[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rows = decodeFintualCashInterests(await fetchPage(cookie, page * PAGE));
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
  throw new Error(`Fintual cash interests: more than ${MAX_PAGES * PAGE} rows — paging is not advancing`);
}
