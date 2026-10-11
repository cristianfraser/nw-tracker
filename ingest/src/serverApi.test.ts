import { describe, expect, it } from "vitest";
import {
  createIngestClient,
  IngestConnectionError,
  IngestRequestError,
  pensionAccountBalanceKind,
  type IngestConnectionRetry,
  type PensionAccountBalancePayload,
} from "nw-tracker-contracts";
import { describeIngestFailure } from "./serverApi.js";

/** What Node's fetch throws when the socket fails before the server answers. */
function connectionFailure(code: string, message = `connect ${code}`): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

const APPLIED = { status: "applied", kind: "pension_account.balance", schema_version: 1 };
const PAYLOAD: PensionAccountBalancePayload = {
  provider: "afp_uno",
  product: "mandatory",
  fund: "A",
  read_at: "2026-10-09T03:32:13.000Z",
  balance: { cuotas: 1, valor_cuota: 1, pesos: 1 },
  recent_movements: [],
};
const SOURCE = { channel: "email", ref: "test" } as const;

/** A client over a scripted fetch: each entry is a Response to answer with or an error to throw. */
function scripted(script: Array<Response | Error>, delays: readonly number[] = [1, 1, 1]) {
  const calls: string[] = [];
  const retries: IngestConnectionRetry[] = [];
  const client = createIngestClient({
    baseUrl: "http://127.0.0.1:3999/",
    feederId: "vitest",
    connectionRetryDelaysMs: delays,
    onRetry: (r) => retries.push(r),
    fetch: (async (input: string | URL | Request) => {
      calls.push(String(input));
      const next = script.shift();
      if (next == null) throw new Error("script exhausted");
      if (next instanceof Error) throw next;
      return next;
    }) as unknown as typeof fetch,
  });
  return { client, calls, retries };
}

const ok = () => new Response(JSON.stringify(APPLIED), { status: 200 });

describe("ingest client connection retries", () => {
  it("sends again when the connection fails before the server answers, and reports each retry", async () => {
    const { client, calls, retries } = scripted([connectionFailure("ECONNRESET"), connectionFailure("UND_ERR_SOCKET", "other side closed"), ok()]);
    const result = await client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE);
    expect(result.status).toBe("applied");
    expect(calls).toEqual(Array(3).fill("http://127.0.0.1:3999/api/ingest/pension_account.balance"));
    expect(retries).toEqual([
      { pathname: "/api/ingest/pension_account.balance", code: "ECONNRESET", attempt: 1, delayMs: 1 },
      { pathname: "/api/ingest/pension_account.balance", code: "UND_ERR_SOCKET", attempt: 2, delayMs: 1 },
    ]);
  });

  it("gives up after the delays with the code and the attempts, which the describer names", async () => {
    const reset = scripted([connectionFailure("ECONNRESET"), connectionFailure("ECONNRESET"), connectionFailure("ECONNRESET")], [1, 1]);
    const err = await reset.client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestConnectionError);
    const conn = err as IngestConnectionError;
    expect(conn.code).toBe("ECONNRESET");
    expect(conn.attempts).toBe(3);
    expect(conn.baseUrl).toBe("http://127.0.0.1:3999");
    expect(reset.calls).toHaveLength(3);
    expect(describeIngestFailure(conn)).toMatch(/did not answer \(ECONNRESET; 3 attempt\(s\) over \d+ s\)/);

    const refused = scripted([connectionFailure("ECONNREFUSED")], []);
    const down = await refused.client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE).catch((e: unknown) => e);
    expect(down).toBeInstanceOf(IngestConnectionError);
    expect((down as IngestConnectionError).attempts).toBe(1);
    expect(describeIngestFailure(down)).toMatch(/not reachable at http:\/\/127\.0\.0\.1:3999 \(1 attempt\(s\) over \d+ s\) — is com\.user\.nw-tracker-server running\?/);
    expect(refused.retries).toEqual([]);
  });

  it("never retries an answer, whatever its status", async () => {
    const refusal = scripted([new Response(JSON.stringify({ error: "invalid_payload", message: "bad" }), { status: 400 }), ok()]);
    const err = await refusal.client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IngestRequestError);
    expect(describeIngestFailure(err)).toBe("ingest 400 invalid_payload: bad");
    expect(refusal.calls).toHaveLength(1);

    const crash = scripted([new Response("Internal Server Error", { status: 500 }), ok()]);
    await expect(crash.client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE)).rejects.toThrow(/ingest 500: Internal Server Error/);
    expect(crash.calls).toHaveLength(1);
  });

  it("lets a failure that is not the connection's through untouched", async () => {
    const { client, calls, retries } = scripted([new Error("boom"), ok()]);
    await expect(client.send(pensionAccountBalanceKind, PAYLOAD, SOURCE)).rejects.toThrow("boom");
    expect(calls).toHaveLength(1);
    expect(retries).toEqual([]);
    expect(describeIngestFailure(new Error("boom"))).toBe("boom");
    expect(describeIngestFailure(connectionFailure("EPIPE"))).toBe("connection failed (EPIPE): fetch failed");
  });
});
