import http from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { COMPRESS_MIN_BYTES, jsonResponseMiddleware, markJsonResponseCacheable, preferredEncoding } from "./jsonResponse.js";
import { flushUsageLog, resetUsageLogBufferForTest, usageLogMiddleware } from "./usageLog.js";
import { usageDb } from "./usageDb.js";

type Raw = { status: number; headers: http.IncomingHttpHeaders; body: Buffer };

function rawRequest(base: string, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** The body as the client reads it (decoded per Content-Encoding). */
function decoded(r: Raw): string {
  const enc = r.headers["content-encoding"];
  if (enc === "gzip") return zlib.gunzipSync(r.body).toString("utf8");
  if (enc === "br") return zlib.brotliDecompressSync(r.body).toString("utf8");
  if (enc !== undefined) throw new Error(`unexpected encoding ${enc}`);
  return r.body.toString("utf8");
}

async function listen(app: express.Express): Promise<{ server: Server; base: string }> {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const big = {
  rows: Array.from({ length: 200 }, (_, i) => ({ day: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, value: i * 1.5, name: "ñandú <&>" })),
};
const small = { ok: true, n: 1 };
const cachedPayload = markJsonResponseCacheable({ rows: big.rows.map((r) => ({ ...r })) });
const mutablePayload = { rows: big.rows.map((r) => ({ ...r })) };

function routes(app: express.Express): void {
  app.get("/api/big", (_req, res) => {
    res.json(big);
  });
  app.get("/api/small", (_req, res) => {
    res.json(small);
  });
  app.get("/api/null", (_req, res) => {
    res.json(null);
  });
  app.get("/api/number", (_req, res) => {
    res.json(42);
  });
  app.get("/api/error", (_req, res) => {
    res.status(404).json({ error: "nope" });
  });
  app.get("/api/cached", (_req, res) => {
    res.json(cachedPayload);
  });
  app.get("/api/mutable", (_req, res) => {
    res.json(mutablePayload);
  });
  app.get("/api/encoded", (_req, res) => {
    res.setHeader("Content-Encoding", "identity");
    res.json(big);
  });
  app.get("/api/no-transform", (_req, res) => {
    res.setHeader("Cache-Control", "no-transform");
    res.json(big);
  });
}

describe("jsonResponseMiddleware", () => {
  let plain: { server: Server; base: string };
  let wrapped: { server: Server; base: string };

  beforeAll(async () => {
    const a = express();
    routes(a);
    plain = await listen(a);
    const b = express();
    b.use(jsonResponseMiddleware());
    routes(b);
    wrapped = await listen(b);
  });
  afterAll(() => {
    plain.server.close();
    wrapped.server.close();
  });

  it("serves exactly what Express's res.json serves, in every encoding", async () => {
    for (const path of ["/api/big", "/api/small", "/api/null", "/api/number", "/api/error", "/api/cached"]) {
      const ref = await rawRequest(plain.base, path);
      for (const enc of [undefined, "gzip", "br", "gzip, deflate, br", "identity", "deflate"]) {
        const r = await rawRequest(wrapped.base, path, enc ? { "Accept-Encoding": enc } : {});
        expect(r.status, `${path} ${enc}`).toBe(ref.status);
        expect(decoded(r), `${path} ${enc}`).toBe(ref.body.toString("utf8"));
        expect(r.headers["content-type"]).toBe(ref.headers["content-type"]);
        // The ETag of the uncompressed body, whatever the encoding (weak: same representation).
        expect(r.headers.etag).toBe(ref.headers.etag);
        expect(Number(r.headers["content-length"])).toBe(r.body.length);
      }
    }
    expect((await rawRequest(wrapped.base, "/api/big")).headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("compresses above the threshold only, with Vary, preferring brotli", async () => {
    expect(Buffer.byteLength(JSON.stringify(big))).toBeGreaterThan(COMPRESS_MIN_BYTES);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThan(COMPRESS_MIN_BYTES);

    const gz = await rawRequest(wrapped.base, "/api/big", { "Accept-Encoding": "gzip" });
    expect(gz.headers["content-encoding"]).toBe("gzip");
    expect(gz.headers.vary).toBe("Accept-Encoding");
    expect(gz.body.length).toBeLessThan(Buffer.byteLength(JSON.stringify(big)));

    const both = await rawRequest(wrapped.base, "/api/big", { "Accept-Encoding": "gzip, deflate, br" });
    expect(both.headers["content-encoding"]).toBe("br");
    const preferGzip = await rawRequest(wrapped.base, "/api/big", { "Accept-Encoding": "br;q=0.5, gzip" });
    expect(preferGzip.headers["content-encoding"]).toBe("gzip");

    const none = await rawRequest(wrapped.base, "/api/big");
    expect(none.headers["content-encoding"]).toBeUndefined();
    expect(none.headers.vary).toBe("Accept-Encoding"); // a cache must still key on it

    const tiny = await rawRequest(wrapped.base, "/api/small", { "Accept-Encoding": "gzip" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();
    expect(tiny.headers.vary).toBeUndefined();
  });

  it("never compresses twice or against no-transform", async () => {
    const pre = await rawRequest(wrapped.base, "/api/encoded", { "Accept-Encoding": "gzip" });
    expect(pre.headers["content-encoding"]).toBe("identity");
    expect(pre.body.toString("utf8")).toBe(JSON.stringify(big));
    const nt = await rawRequest(wrapped.base, "/api/no-transform", { "Accept-Encoding": "gzip" });
    expect(nt.headers["content-encoding"]).toBeUndefined();
    expect(nt.body.toString("utf8")).toBe(JSON.stringify(big));
  });

  it("answers HEAD with the GET headers and no body", async () => {
    const get = await rawRequest(wrapped.base, "/api/big", { "Accept-Encoding": "gzip" });
    const head = await rawRequest(wrapped.base, "/api/big", { "Accept-Encoding": "gzip" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.headers.etag).toBe(get.headers.etag);
  });

  it("answers 304 to a matching If-None-Match, in any encoding", async () => {
    const first = await rawRequest(wrapped.base, "/api/cached", { "Accept-Encoding": "gzip" });
    const etag = first.headers.etag!;
    for (const enc of ["gzip", "br", "identity"]) {
      const again = await rawRequest(wrapped.base, "/api/cached", { "Accept-Encoding": enc, "If-None-Match": etag });
      expect(again.status).toBe(304);
      expect(again.body.length).toBe(0);
      expect(again.headers["content-length"]).toBeUndefined();
    }
    const stale = await rawRequest(wrapped.base, "/api/cached", { "If-None-Match": 'W/"0-nope"' });
    expect(stale.status).toBe(200);
  });

  it("serializes a marked payload once and every other payload per response", async () => {
    const before = decoded(await rawRequest(wrapped.base, "/api/cached", { "Accept-Encoding": "gzip" }));
    expect(before).toBe(JSON.stringify(cachedPayload));
    const beforeMutable = decoded(await rawRequest(wrapped.base, "/api/mutable"));
    // A marked payload is immutable by contract: its bytes are reused, which this shows.
    cachedPayload.rows[0]!.value = -1;
    mutablePayload.rows[0]!.value = -1;
    for (const enc of ["gzip", "br", "identity"]) {
      expect(decoded(await rawRequest(wrapped.base, "/api/cached", { "Accept-Encoding": enc }))).toBe(before);
    }
    const afterMutable = decoded(await rawRequest(wrapped.base, "/api/mutable"));
    expect(afterMutable).not.toBe(beforeMutable);
    expect(afterMutable).toBe(JSON.stringify(mutablePayload));
  });
});

describe("preferredEncoding", () => {
  it("follows q-values, brotli on a tie", () => {
    expect(preferredEncoding(undefined)).toBeNull();
    expect(preferredEncoding("")).toBeNull();
    expect(preferredEncoding("identity")).toBeNull();
    expect(preferredEncoding("deflate")).toBeNull();
    expect(preferredEncoding("gzip")).toBe("gzip");
    expect(preferredEncoding("br")).toBe("br");
    expect(preferredEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(preferredEncoding("GZIP;q=1, BR;q=0.8")).toBe("gzip");
    expect(preferredEncoding("br;q=0, gzip;q=0.1")).toBe("gzip");
    expect(preferredEncoding("br;q=0, gzip;q=0")).toBeNull();
    expect(preferredEncoding("*")).toBe("br");
    expect(preferredEncoding("*;q=0.5, br;q=0")).toBe("gzip");
  });
});

describe("usage log with compressed responses", () => {
  it("records the uncompressed payload size, and no size for a 304", async () => {
    const payload = markJsonResponseCacheable({ rows: big.rows.map((r) => ({ ...r })) });
    const app = express();
    app.use(usageLogMiddleware());
    app.use(jsonResponseMiddleware());
    app.get("/api/vitest-json-size", (_req, res) => {
      res.json(payload);
    });
    const { server, base } = await listen(app);
    try {
      resetUsageLogBufferForTest();
      usageDb().prepare(`DELETE FROM usage_endpoint_hourly WHERE route = '/api/vitest-json-size'`).run();
      const gz = await rawRequest(base, "/api/vitest-json-size", { "Accept-Encoding": "gzip" });
      expect(gz.headers["content-encoding"]).toBe("gzip");
      await rawRequest(base, "/api/vitest-json-size", { "If-None-Match": gz.headers.etag! });
      await new Promise((r) => setTimeout(r, 20)); // 'finish' runs after the client has the body
      flushUsageLog();
      const row = usageDb()
        .prepare(`SELECT count, bytes_total, bytes_samples FROM usage_endpoint_hourly WHERE route = '/api/vitest-json-size'`)
        .get() as { count: number; bytes_total: number; bytes_samples: number };
      expect(row).toEqual({
        count: 2,
        bytes_total: Buffer.byteLength(JSON.stringify(payload)),
        bytes_samples: 1,
      });
    } finally {
      usageDb().prepare(`DELETE FROM usage_endpoint_hourly WHERE route = '/api/vitest-json-size'`).run();
      server.close();
    }
  });
});
