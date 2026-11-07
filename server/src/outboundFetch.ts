import { fetchOut } from "./httpOut.js";

/**
 * Every sync's outbound HTTP (2026-11-07, docs/untangle-plan.md F14): one place states the user
 * agent, the timeout, how the body is decoded and the optional rate gate, instead of eight
 * modules each spelling their own `fetch` with its own headers. What a source does with the text
 * (its parser, its error wording) stays in the source. Requests go through `fetchOut`, so
 * `DEBUG_HTTP_OUT` logs them all.
 */

/**
 * A normal browser's user agent, for the sites that refuse anything else (Yahoo answers 401, the
 * Bolsa de Santiago and AFP UNO's API want a browser too).
 */
export const BROWSER_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** Unless a request says otherwise: long enough for a year of a public CSV, short enough that a dead host cannot stall a sync forever. */
export const OUTBOUND_TIMEOUT_MS = 60_000;

/** A shared rate gate (Banco Central's, `sbifApiGate.ts`): waited for before, told the outcome after (a non-2xx answer is a failure). */
export type OutboundGate = {
  acquire: () => Promise<void>;
  success: () => void;
  failure: (e: unknown) => void;
};

export type OutboundRequest = {
  /** For the log and nothing else (`sp_afp:A:2026-2026`). */
  label: string;
  url: string;
  /** Who is asking: the app's own name for public data, {@link BROWSER_USER_AGENT} where a site insists. */
  userAgent: string;
  accept?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** `latin1` for the SP's CSVs and the SII's pages; `utf8` otherwise. */
  decode?: "utf8" | "latin1";
  gate?: OutboundGate;
  /** Tests: a stand-in for `fetch`. */
  fetchImpl?: typeof fetch;
};

export type OutboundResponse = {
  status: number;
  ok: boolean;
  text: string;
};

/** The response decoded as text; the caller decides what a non-2xx status means. */
export async function fetchOutboundText(req: OutboundRequest): Promise<OutboundResponse> {
  await req.gate?.acquire();
  try {
    const timeout = AbortSignal.timeout(req.timeoutMs ?? OUTBOUND_TIMEOUT_MS);
    const init: RequestInit = {
      method: req.method ?? "GET",
      headers: {
        "User-Agent": req.userAgent,
        ...(req.accept ? { Accept: req.accept } : {}),
        ...req.headers,
      },
      body: req.body,
      signal: req.signal ? AbortSignal.any([req.signal, timeout]) : timeout,
    };
    const res = req.fetchImpl ? await req.fetchImpl(req.url, init) : await fetchOut(req.label, req.url, init);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder(req.decode === "latin1" ? "latin1" : "utf-8").decode(bytes);
    if (req.gate) {
      if (res.ok) req.gate.success();
      else req.gate.failure(new Error(`${req.label} HTTP ${res.status}: ${text.slice(0, 500)}`));
    }
    return { status: res.status, ok: res.ok, text };
  } catch (e) {
    req.gate?.failure(e);
    throw e;
  }
}
