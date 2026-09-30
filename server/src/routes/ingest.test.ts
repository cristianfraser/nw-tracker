import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  INGEST_KINDS,
  IngestRequestError,
  createIngestClient,
  defineIngestKind,
  ingestJsonSchemas,
  type IngestKindDefinition,
} from "nw-tracker-contracts";
import type { IngestApplyContext, IngestHandler } from "../ingestHandlers.js";
import { registerIngestRoutes, type IngestRoutesOptions } from "./ingest.js";

/** A synthetic kind: the route and client are tested on their own, not on a real source. */
const testKind = defineIngestKind({
  kind: "test.note",
  schema_version: 2,
  description: "Synthetic test kind.",
  payload: z.object({ text: z.string().min(1), amount: z.number().int() }).strict(),
});

const LOCAL_AUTH = { token: null, allowRemote: false, demoMode: false };
const SOURCE = { channel: "file", ref: "sha256:test" } as const;

let server: Server | null = null;

afterEach(async () => {
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

function recordingHandler(outcome: "applied" | "duplicate" | "conflict" = "applied") {
  const seen: IngestApplyContext<unknown>[] = [];
  const handler: IngestHandler<unknown> = {
    apply(ctx) {
      seen.push(ctx);
      return { status: outcome, message: `saw ${JSON.stringify(ctx.payload)}` };
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
    const { handler } = recordingHandler("conflict");
    const base = await startApp({ kinds, handlers: { "test.note": handler }, auth: LOCAL_AUTH });
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    expect((await client.send(testKind, { text: "x", amount: 1 }, SOURCE)).status).toBe("conflict");

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
      kinds: [{ kind: "test.note", schema_version: 2, description: "Synthetic test kind." }],
    });
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
    expect(Object.keys(ingestJsonSchemas().kinds)).toEqual((INGEST_KINDS as readonly IngestKindDefinition[]).map((k) => k.kind));
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
