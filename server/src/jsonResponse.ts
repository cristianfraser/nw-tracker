import zlib from "node:zlib";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * JSON responses: serialized once per cached payload, and compressed on the wire.
 *
 * `jsonResponseMiddleware` replaces `res.json` on every `/api` request with {@link sendJson}, so
 * routes keep calling `res.json(payload)`:
 *
 * - The body is exactly what Express's `res.json` sends (`JSON.stringify(payload)`: the app sets
 *   no `json replacer` / `json spaces` / `json escape`), with the same `Content-Type`
 *   (`application/json; charset=utf-8`) and the same weak ETag (the app's `etag fn` over the
 *   uncompressed bytes), so a 304 works as before and across encodings.
 * - A payload a response cache marked with {@link markJsonResponseCacheable} is serialized once:
 *   its bytes, ETag and compressed forms live in a WeakMap keyed by the payload object, so they
 *   live exactly as long as the cache entry holding the object — every invalidation that drops
 *   or rebuilds the entry drops them with it, whichever prefix, dependency or day rollover did
 *   it. Only cached response objects are marked: an object a route may mutate between requests
 *   (a scheduler's state) must never be, or a later request would be served stale bytes.
 * - A body of {@link COMPRESS_MIN_BYTES} or more carries `Vary: Accept-Encoding` and goes out
 *   brotli- or gzip-encoded when the client accepts one (brotli first: browsers offer it only on
 *   HTTPS, gzip everywhere). Never when the response already has a `Content-Encoding` or says
 *   `Cache-Control: no-transform`.
 *
 * Levels: a cached payload is compressed once per build and served many times, so it pays for
 * a better ratio (gzip 6, brotli 5); a payload built per request is compressed per request at
 * gzip 1 / brotli 1, a few ms for the largest uncached payloads instead of ~4x that.
 * The usage log records the uncompressed size (`res.locals.usageBodyBytes`), so its «mean size»
 * stays the payload size whatever the client accepted.
 */

export const COMPRESS_MIN_BYTES = 1024;

type Encoding = "br" | "gzip";

type Serialized = {
  body: Buffer;
  etag: string | undefined;
  encoded: Partial<Record<Encoding, Buffer>>;
};

const cacheablePayloads = new WeakSet<object>();
const serializedByPayload = new WeakMap<object, Serialized>();

/**
 * Mark a cached response payload as immutable for serialization: the first response serializes
 * (and, per encoding, compresses) it, later responses reuse the bytes. Returns the payload.
 */
export function markJsonResponseCacheable<T>(payload: T): T {
  if (payload !== null && typeof payload === "object") cacheablePayloads.add(payload as object);
  return payload;
}

function compress(body: Buffer, encoding: Encoding, cached: boolean): Buffer {
  if (encoding === "gzip") return zlib.gzipSync(body, { level: cached ? 6 : 1 });
  return zlib.brotliCompressSync(body, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: cached ? 5 : 1,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length,
      [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
    },
  });
}

function serialize(req: Request, payload: unknown): Serialized {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  const etagFn: unknown = req.app.get("etag fn");
  const etag = typeof etagFn === "function" ? (etagFn(body, undefined) as string | undefined) : undefined;
  return { body, etag, encoded: {} };
}

function negotiateEncoding(req: Request, res: Response, length: number): Encoding | null {
  if (length < COMPRESS_MIN_BYTES) return null;
  if (res.getHeader("Content-Encoding") !== undefined) return null;
  const cacheControl = res.getHeader("Cache-Control");
  if (typeof cacheControl === "string" && /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(cacheControl)) return null;
  res.vary("Accept-Encoding");
  return preferredEncoding(req.get("Accept-Encoding"));
}

/**
 * brotli or gzip by the client's q-values, brotli on a tie (browsers list `gzip, deflate, br`, so
 * client order would always pick gzip); null when neither is acceptable (`identity`, `deflate`,
 * `br;q=0`, no header).
 */
export function preferredEncoding(header: string | undefined): Encoding | null {
  if (!header) return null;
  const q = new Map<string, number>();
  for (const part of header.split(",")) {
    const [name, ...params] = part.trim().toLowerCase().split(";");
    if (!name?.trim()) continue;
    let weight = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/.exec(p);
      if (m) weight = Number(m[1]);
    }
    if (Number.isFinite(weight)) q.set(name.trim(), weight);
  }
  const weight = (name: string) => q.get(name) ?? q.get("*") ?? 0;
  const br = weight("br");
  const gzip = weight("gzip");
  if (br <= 0 && gzip <= 0) return null;
  return br >= gzip ? "br" : "gzip";
}

/** `res.json(payload)` with the cached serialization and compression described above. */
export function sendJson(req: Request, res: Response, payload: unknown, originalJson: Response["json"]): Response {
  if (payload === null || typeof payload !== "object" || res.getHeader("Content-Type") !== undefined) {
    // Scalars and a preset Content-Type: Express's own path (rare, small).
    return originalJson.call(res, payload);
  }
  const object = payload as object;
  const cacheable = cacheablePayloads.has(object);
  let s = cacheable ? serializedByPayload.get(object) : undefined;
  if (!s) {
    s = serialize(req, payload);
    if (cacheable) serializedByPayload.set(object, s);
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (s.etag !== undefined && res.getHeader("ETag") === undefined) res.setHeader("ETag", s.etag);
  // A fresh conditional request: `send` answers 304 without a body (and strips the length).
  if (req.fresh) return res.send(s.body);
  res.locals.usageBodyBytes = s.body.length;
  const encoding = negotiateEncoding(req, res, s.body.length);
  if (!encoding) return res.send(s.body);
  let encoded = s.encoded[encoding];
  if (!encoded) {
    encoded = compress(s.body, encoding, cacheable);
    if (cacheable) s.encoded[encoding] = encoded;
  }
  res.setHeader("Content-Encoding", encoding);
  return res.send(encoded);
}

/** Install {@link sendJson} as `res.json` for `/api` requests. */
export function jsonResponseMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/api" || req.path.startsWith("/api/")) {
      const originalJson = res.json;
      res.json = ((payload: unknown) => sendJson(req, res, payload, originalJson)) as Response["json"];
    }
    next();
  };
}
