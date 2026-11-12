import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  IngestRequestError,
  bankAccountBalancesKind,
  createIngestClient,
  defineIngestKind,
  ingestJsonSchemas,
  type IngestKindDefinition,
} from "nw-tracker-contracts";
import { db } from "../db.js";
import { INGEST_HANDLERS, type IngestApplyContext, type IngestHandler } from "../ingestHandlers.js";
import { IngestConflict } from "../ingestReceiver.js";
import { registerIngestRoutes, type IngestRoutesOptions } from "./ingest.js";

/** A synthetic kind: the route and client are tested on their own, not on a real source. */
const testKind = defineIngestKind({
  kind: "test.note",
  schema_version: 2,
  description: "Synthetic test kind.",
  ref: "read",
  payload: z.object({ text: z.string().min(1), amount: z.number().int() }).strict(),
});

/** The same payload as an immutable document: the receiver keeps its ref once applied. */
const docKind = defineIngestKind({ ...testKind, kind: "test.document", ref: "document" });

db.exec(`CREATE TABLE IF NOT EXISTS vitest_ingest_notes (text TEXT NOT NULL)`);
const notes = () => (db.prepare(`SELECT text FROM vitest_ingest_notes ORDER BY rowid`).all() as { text: string }[]).map((r) => r.text);

/** Writes the note, so a rollback shows. */
function writingHandler(retry = false) {
  let calls = 0;
  const handler: IngestHandler<{ text: string; amount: number }> = {
    apply({ payload }) {
      calls++;
      db.prepare(`INSERT INTO vitest_ingest_notes (text) VALUES (?)`).run(payload.text);
      return { details: { wrote: payload.text }, retry };
    },
  };
  return { handler, calls: () => calls };
}

const LOCAL_AUTH = { token: null, allowRemote: false, demoMode: false };
const SOURCE = { channel: "file", ref: "sha256:test" } as const;

let server: Server | null = null;

afterEach(async () => {
  db.exec(`DELETE FROM vitest_ingest_notes`);
  db.prepare(`DELETE FROM ingest_documents WHERE kind = ?`).run(docKind.kind);
  const s = server;
  server = null;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

async function startApp(options: IngestRoutesOptions): Promise<string> {
  const app = express();
  app.use(express.json());
  registerIngestRoutes(app, options);
  app.use(
    (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  );
  const s = await new Promise<Server>((resolve) => {
    const started: Server = app.listen(0, "127.0.0.1", () => resolve(started));
  });
  server = s;
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

function recordingHandler(conflict = false) {
  const seen: IngestApplyContext<unknown>[] = [];
  const handler: IngestHandler<unknown> = {
    apply(ctx) {
      seen.push(ctx);
      if (conflict) throw new IngestConflict("disagrees", [{ at: "vitest:1", fields: ["amount"], message: "amount differs" }], { report: ["x"] });
      return { message: `saw ${JSON.stringify(ctx.payload)}` };
    },
  };
  return { seen, handler };
}

function post(base: string, kind: string, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}/api/ingest/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const kinds: readonly IngestKindDefinition[] = [testKind];

describe("registerIngestRoutes", () => {
  it("applies a valid document through the client and returns the handler's outcome", async () => {
    const { seen, handler } = recordingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const result = await client.send(testKind, { text: "hola", amount: 5 }, SOURCE);
    expect(result).toEqual({
      status: "applied",
      kind: "test.note",
      schema_version: 2,
      retry: false,
      dry_run: false,
      message: 'saw {"text":"hola","amount":5}',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.envelope.feeder_id).toBe("vitest");
    expect(seen[0]?.envelope.source).toEqual(SOURCE);
  });

  it("refuses an unknown kind, a wrong version and a bad payload before any handler runs", async () => {
    const { seen, handler } = recordingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const envelope = { schema_version: 2, feeder_id: "vitest", source: SOURCE };

    const unknown = await post(base, "test.other", { ...envelope, payload: {} });
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).error).toBe("unknown_ingest_kind");

    const version = await post(base, "test.note", {
      ...envelope,
      schema_version: 1,
      payload: { text: "a", amount: 1 },
    });
    expect(version.status).toBe(400);
    expect((await version.json()).error).toBe("unsupported_schema_version");

    const payload = await post(base, "test.note", { ...envelope, payload: { text: "", amount: 1.5 } });
    expect(payload.status).toBe(400);
    const payloadBody = await payload.json();
    expect(payloadBody.error).toBe("invalid_payload");
    expect(payloadBody.issues.length).toBeGreaterThan(0);

    const noEnvelope = await post(base, "test.note", { payload: { text: "a", amount: 1 } });
    expect(noEnvelope.status).toBe(400);
    expect((await noEnvelope.json()).error).toBe("invalid_envelope");

    const extraField = await post(base, "test.note", {
      ...envelope,
      payload: { text: "a", amount: 1 },
      kind: "test.note",
    });
    expect(extraField.status).toBe(400);

    expect(seen).toHaveLength(0);
  });

  it("validates in the client before sending", async () => {
    const { seen, handler } = recordingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    await expect(client.send(testKind, { text: "", amount: 1 }, SOURCE)).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });

  it("reports a conflict as a result, and a server refusal as an IngestRequestError", async () => {
    const { handler } = recordingHandler(true);
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    expect(await client.send(testKind, { text: "x", amount: 1 }, SOURCE)).toEqual({
      status: "conflict",
      kind: "test.note",
      schema_version: 2,
      retry: false,
      dry_run: false,
      message: "disagrees",
      conflicts: [{ at: "vitest:1", fields: ["amount"], message: "amount differs" }],
      details: { report: ["x"] },
    });

    const newer = defineIngestKind({ ...testKind, schema_version: 3 });
    const err = await client.send(newer, { text: "x", amount: 1 }, SOURCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestRequestError);
    expect((err as IngestRequestError).httpStatus).toBe(400);
    expect((err as IngestRequestError).body?.error).toBe("unsupported_schema_version");
  });

  it("turns a handler fault into a 500", async () => {
    const base = await startApp({
      kinds,
      handlers: {
        "test.note": {
          apply() {
            throw new Error("boom");
          },
        },
      },
      auth: LOCAL_AUTH,
    });
    const res = await post(base, "test.note", {
      schema_version: 2,
      feeder_id: "vitest",
      source: SOURCE,
      payload: { text: "a", amount: 1 },
    });
    expect(res.status).toBe(500);
  });

  it("requires the token when one is configured, and sends it from the client", async () => {
    const { handler } = recordingHandler();
    const base = await startApp({
      kinds,
      handlers: { "test.note": handler },
      auth: { token: "s3cret", allowRemote: false, demoMode: false },
    });
    const without = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const err = await without.send(testKind, { text: "a", amount: 1 }, SOURCE).catch((e: unknown) => e);
    expect((err as IngestRequestError).httpStatus).toBe(401);

    const wrong = createIngestClient({ baseUrl: base, feederId: "vitest", token: "nope" });
    expect(
      ((await wrong.send(testKind, { text: "a", amount: 1 }, SOURCE).catch((e: unknown) => e)) as IngestRequestError)
        .httpStatus
    ).toBe(401);

    const right = createIngestClient({ baseUrl: base, feederId: "vitest", token: "s3cret" });
    expect((await right.send(testKind, { text: "a", amount: 1 }, SOURCE)).status).toBe("applied");
  });

  it("refuses everything in demo mode", async () => {
    const { handler } = recordingHandler();
    const base = await startApp({
      kinds,
      handlers: { "test.note": handler },
      auth: { token: null, allowRemote: false, demoMode: true },
    });
    const res = await fetch(`${base}/api/ingest/kinds`);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("ingest_disabled");
  });

  it("lists the accepted kinds", async () => {
    const { handler } = recordingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    expect(await (await fetch(`${base}/api/ingest/kinds`)).json()).toEqual({
      kinds: [{ kind: "test.note", schema_version: 2, ref: "read", description: "Synthetic test kind." }],
    });
  });

  it("rolls a dry run back and reports what the handler did", async () => {
    const { handler } = writingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const dry = await client.send(testKind, { text: "dry", amount: 1 }, SOURCE, { dryRun: true });
    expect(dry).toMatchObject({ status: "applied", dry_run: true, details: { wrote: "dry" } });
    expect(notes()).toEqual([]);
    await client.send(testKind, { text: "real", amount: 1 }, SOURCE);
    expect(notes()).toEqual(["real"]);
  });

  it("applies a read kind on every send", async () => {
    const { handler, calls } = writingHandler();
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    await client.send(testKind, { text: "a", amount: 1 }, SOURCE);
    await client.send(testKind, { text: "b", amount: 2 }, SOURCE);
    expect(calls()).toBe(2);
    expect(notes()).toEqual(["a", "b"]);
  });

  it("keeps a document's ref once applied: the same payload is a duplicate, another a conflict", async () => {
    const { handler, calls } = writingHandler();
    const base = await startApp({ kinds: [docKind], handlers: { "test.document": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    await client.send(docKind, { text: "a", amount: 1 }, SOURCE, { dryRun: true });
    expect((await client.send(docKind, { text: "a", amount: 1 }, SOURCE)).status).toBe("applied");
    const again = await client.send(docKind, { text: "a", amount: 1 }, SOURCE);
    expect(again).toMatchObject({ status: "duplicate", retry: false, details: { wrote: "a" } });
    const other = await client.send(docKind, { text: "b", amount: 1 }, SOURCE);
    expect(other.status).toBe("conflict");
    expect(other.conflicts?.[0]).toMatchObject({ at: `ingest_documents:test.document|${SOURCE.ref}`, fields: ["payload_sha256"] });
    // The dry run, the first send; never the duplicate or the conflict.
    expect(calls()).toBe(2);
    expect(notes()).toEqual(["a"]);
  });

  it("does not keep a document whose outcome may change, so a resend runs again", async () => {
    const { handler, calls } = writingHandler(true);
    const base = await startApp({ kinds: [docKind], handlers: { "test.document": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    expect((await client.send(docKind, { text: "a", amount: 1 }, SOURCE)).retry).toBe(true);
    expect((await client.send(docKind, { text: "a", amount: 1 }, SOURCE)).status).toBe("applied");
    expect(calls()).toBe(2);
  });

  it("fails at registration when a kind and the handlers disagree", () => {
    const { handler } = recordingHandler();
    expect(() => registerIngestRoutes(express(), { kinds, handlers: {}, auth: LOCAL_AUTH })).toThrow(
      /no server handler/
    );
    expect(() =>
      registerIngestRoutes(express(), {
        kinds: [],
        handlers: { "test.note": handler },
        auth: LOCAL_AUTH,
      })
    ).toThrow(/no contract kind/);
    expect(() =>
      registerIngestRoutes(express(), {
        kinds: [testKind, testKind],
        handlers: { "test.note": handler },
        auth: LOCAL_AUTH,
      })
    ).toThrow(/Duplicate ingest kind/);
  });

  it("registers with the real contract kinds and handlers", () => {
    expect(() => registerIngestRoutes(express(), { auth: LOCAL_AUTH })).not.toThrow();
  });
});

describe("ingestJsonSchemas", () => {
  it("exports each kind's payload schema with its version", () => {
    const schemas = ingestJsonSchemas([testKind]);
    expect(schemas.kinds["test.note"]?.schema_version).toBe(2);
    expect(schemas.kinds["test.note"]?.payload).toMatchObject({
      type: "object",
      required: ["text", "amount"],
    });
  });
});

describe("currencies on receipt", () => {
  const balances = (currency: string) => ({
    issuer: "santander",
    observed_at: "2026-11-12T10:00:00-03:00",
    accounts: [{ number: "900000001", product: "checking" as const, currency, balance: 10.5, label: "Cuenta vitest", status: "VIGENTE" }],
  });

  async function sendBalances(currency: string): Promise<IngestRequestError> {
    const base = await startApp({
      kinds: [bankAccountBalancesKind],
      handlers: { "bank_account.balances": INGEST_HANDLERS["bank_account.balances"] },
      auth: LOCAL_AUTH,
    });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest", connectionRetryDelaysMs: [] });
    const err = await client
      .send(bankAccountBalancesKind, balances(currency), { channel: "file", ref: `vitest-cur-${currency}` })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestRequestError);
    return err as IngestRequestError;
  }

  it("refuses a known currency the handler cannot take yet, naming it and the kind", async () => {
    const err = await sendBalances("eur");
    expect(err.httpStatus).toBe(422);
    expect(err.body?.error).toBe("unsupported_currency");
    expect(err.body?.message).toMatch(/bank_account\.balances.*EUR/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM bank_account_balance_snapshots WHERE source_ref = 'vitest-cur-eur'`).get()).toEqual({ n: 0 });
  });

  it("refuses a code the currencies table does not know", async () => {
    const err = await sendBalances("xyz");
    expect(err.httpStatus).toBe(422);
    expect(err.body?.error).toBe("unknown_currency");
    expect(err.body?.message).toMatch(/"xyz"/);
  });
});
