/**
 * Which ticker a broker mail's company name is, asked of Yahoo's public symbol search — a HINT for
 * the person who maps the name (`FUND_NAME_TICKERS` on the server), never booked from: the planner
 * refuses an unknown name, and booking shares against the wrong holding is not recoverable.
 *
 * A hint is given only when exactly one US-listed share or fund carries the mail's name (compared
 * without case, punctuation or a trailing «Inc», «Corp», «PBC», …); the mail's fill price is quoted
 * beside it so the person can check the quote. Fintual's dollar account only holds US lines.
 */

const SEARCH_URL = "https://query2.finance.yahoo.com/v1/finance/search";
/** Yahoo's exchange codes for the US venues (Nasdaq tiers, NYSE, Arca, American, Cboe). */
const US_EXCHANGES = new Set(["NMS", "NGM", "NCM", "NYQ", "PCX", "ASE", "BTS"]);
const SECURITY_TYPES = new Set(["EQUITY", "ETF"]);
const LEGAL_SUFFIXES = /\b(inc|incorporated|corp|corporation|co|company|plc|pbc|ltd|limited|sa|ag|nv|lp|llc|class [a-z]|common stock)\b/g;

export type YahooSearchQuote = {
  symbol?: string;
  quoteType?: string;
  exchange?: string;
  longname?: string;
  shortname?: string;
};

export type TickerHint =
  | { kind: "match"; symbol: string; name: string; exchange: string }
  | { kind: "none"; candidates: string[] };

/** The name as a comparison key: lower case, accents and punctuation gone, legal suffixes dropped. */
export function companyNameKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(LEGAL_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The one US listing whose name is the mail's, from a search answer; else the candidates seen. */
export function tickerHintFromSearch(fundName: string, quotes: readonly YahooSearchQuote[]): TickerHint {
  const key = companyNameKey(fundName);
  const us = quotes.filter(
    (q) => typeof q.symbol === "string" && SECURITY_TYPES.has(q.quoteType ?? "") && US_EXCHANGES.has(q.exchange ?? "")
  );
  const named = us.filter((q) => {
    const name = q.longname ?? q.shortname;
    return name != null && companyNameKey(name) === key;
  });
  if (named.length === 1) {
    const q = named[0]!;
    return { kind: "match", symbol: q.symbol!, name: (q.longname ?? q.shortname)!, exchange: q.exchange! };
  }
  return {
    kind: "none",
    candidates: us.slice(0, 5).map((q) => `${q.symbol} (${q.longname ?? q.shortname ?? "no name"}, ${q.exchange})`),
  };
}

/** Ask Yahoo; a failed lookup is reported as such (it is only a hint). */
export async function lookUpTickerHint(fundName: string): Promise<TickerHint | { kind: "failed"; error: string }> {
  const url = `${SEARCH_URL}?q=${encodeURIComponent(fundName)}&quotesCount=10&newsCount=0&listsCount=0`;
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { kind: "failed", error: `Yahoo search HTTP ${res.status}` };
    const body = (await res.json()) as { quotes?: YahooSearchQuote[] };
    return tickerHintFromSearch(fundName, body.quotes ?? []);
  } catch (err) {
    return { kind: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** One line for the log and the run message. */
export function describeTickerHint(
  fundName: string,
  fillPrice: number | null,
  hint: TickerHint | { kind: "failed"; error: string }
): string {
  if (hint.kind === "failed") return `Yahoo lookup of "${fundName}" failed: ${hint.error}`;
  if (hint.kind === "none") {
    return hint.candidates.length > 0
      ? `Yahoo lists no US line named "${fundName}"; it found ${hint.candidates.join(", ")}`
      : `Yahoo lists no US line named "${fundName}"`;
  }
  const fill = fillPrice != null ? ` (the mail's price US$${fillPrice})` : "";
  return `Yahoo lists "${hint.name}" as ${hint.symbol} on ${hint.exchange}${fill} — if that is it, map /${fundName}/ → ${hint.symbol} in FUND_NAME_TICKERS`;
}
