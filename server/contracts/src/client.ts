import type { z } from "zod";
import {
  INGEST_API_PATH,
  ingestErrorSchema,
  ingestResultSchema,
  type IngestErrorBody,
  type IngestResult,
  type IngestSource,
} from "./envelope.js";
import type { IngestKindDefinition } from "./defineKind.js";
import { INGEST_RUNS_API_PATH, ingestRunCompletionSchema, type IngestRunCompletion } from "./runs.js";
import {
  CC_MANUAL_PAYMENT_TASK,
  ccManualPaymentRequestSchema,
  ccManualPaymentResultSchema,
  type CcManualPaymentRequest,
  type CcManualPaymentResult,
  INGEST_TASKS_API_PATH,
  ingestTaskRequestSchema,
  ingestTaskResultSchema,
  type IngestTaskName,
  type IngestTaskRequest,
  type IngestTaskResult,
} from "./tasks.js";

export interface IngestClientOptions {
  /** Server origin, e.g. `http://127.0.0.1:3001`. */
  baseUrl: string;
  feederId: string;
  /** Sent as `Authorization: Bearer <token>` when set (the server requires it when it has one). */
  token?: string;
  fetch?: typeof fetch;
  /**
   * The waits before each retry of a request the server never answered — the connection refused,
   * reset or cut mid-request (a `launchctl kickstart -k` of the server takes ~2 s to come back).
   * Default `DEFAULT_CONNECTION_RETRY_DELAYS_MS`; `[]` sends once.
   */
  connectionRetryDelaysMs?: readonly number[];
  /** Called before each retry, so a run log shows the failure the retry rode out. */
  onRetry?: (retry: IngestConnectionRetry) => void;
}

/** Three retries over 30 s. */
export const DEFAULT_CONNECTION_RETRY_DELAYS_MS: readonly number[] = [2_000, 8_000, 20_000];

export interface IngestConnectionRetry {
  pathname: string;
  /** `ECONNREFUSED`, `ECONNRESET`, `UND_ERR_SOCKET`, … */
  code: string;
  /** The attempt that just failed, counted from 1. */
  attempt: number;
  delayMs: number;
}

/** A refused request: the server's error body when it sent one, else the raw text. */
export class IngestRequestError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly body: IngestErrorBody | null,
    readonly rawText: string
  ) {
    super(
      body
        ? `ingest ${httpStatus} ${body.error}: ${body.message}`
        : `ingest ${httpStatus}: ${rawText.slice(0, 500)}`
    );
    this.name = "IngestRequestError";
  }
}

/** A request the server never answered: the connection failed on every attempt. */
export class IngestConnectionError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly code: string,
    readonly attempts: number,
    readonly elapsedMs: number,
    cause: unknown
  ) {
    super(`no answer from ${baseUrl} (${code}) after ${attempts} attempt(s) over ${Math.round(elapsedMs / 1000)} s`, {
      cause,
    });
    this.name = "IngestConnectionError";
  }
}

/**
 * The code of a request that failed before the server answered, else null. Node's fetch throws
 * `TypeError: fetch failed` with the socket error as `cause` (`ECONNREFUSED`, `ECONNRESET`,
 * `UND_ERR_SOCKET` …); an HTTP answer, a schema failure or any other error has no code here.
 */
export function connectionFailureCode(err: unknown): string | null {
  if (!(err instanceof Error) || err instanceof IngestRequestError || err instanceof IngestConnectionError) return null;
  const cause = err.cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === "string" && code !== "" ? code : cause.message || cause.name;
  }
  return err instanceof TypeError && err.message === "fetch failed" ? "fetch failed" : null;
}

export interface IngestClient {
  /**
   * Validates `payload` against the kind's schema here (a malformed document fails in the
   * feeder, before any request), sends it, and returns what the server did. Throws
   * `IngestRequestError` on a refusal and on a server error, `IngestConnectionError` when the
   * server never answered (after the connection retries).
   */
  send<S extends z.ZodType>(
    kind: IngestKindDefinition<string, S>,
    payload: z.input<S>,
    source: IngestSource
  ): Promise<IngestResult>;
  /** Report a run the server asked for as finished. */
  completeRun(runId: number, completion: IngestRunCompletion): Promise<void>;
  /** Ask the server to run one of its tasks (`tasks.ts`); resolves with its report. */
  runTask(task: IngestTaskName, request?: IngestTaskRequest): Promise<IngestTaskResult>;
  /** Record a card payment entered by hand (`tasks.ts`, `cc_manual_payment`). */
  recordManualCardPayment(request: CcManualPaymentRequest): Promise<CcManualPaymentResult>;
}

export function createIngestClient(options: IngestClientOptions): IngestClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const retryDelays = options.connectionRetryDelaysMs ?? DEFAULT_CONNECTION_RETRY_DELAYS_MS;
  /**
   * The request, sent again while the connection fails before the server answers. Repeating one
   * whose answer was lost is safe by contract: a kind answers `duplicate` to a payload it already
   * applied, a task run twice finds its work done, and a run report sent twice is refused as
   * `run_not_waiting`. An HTTP answer, whatever its status, is never retried.
   */
  async function fetchWithRetry(pathname: string, init: RequestInit): Promise<Response> {
    const startedAt = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        return await doFetch(`${base}${pathname}`, init);
      } catch (err) {
        const code = connectionFailureCode(err);
        if (code == null) throw err;
        const delayMs = retryDelays[attempt - 1];
        if (delayMs == null) throw new IngestConnectionError(base, code, attempt, Date.now() - startedAt, err);
        options.onRetry?.({ pathname, code, attempt, delayMs });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  /** POST a JSON body; the parsed response body, or IngestRequestError on a non-2xx answer. */
  async function post(pathname: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await fetchWithRetry(pathname, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    if (!res.ok) {
      const parsed = ingestErrorSchema.safeParse(json);
      throw new IngestRequestError(res.status, parsed.success ? parsed.data : null, text);
    }
    return json;
  }
  return {
    async send(kind, payload, source) {
      const checked = kind.payload.parse(payload);
      const json = await post(`${INGEST_API_PATH}/${kind.kind}`, {
        schema_version: kind.schema_version,
        feeder_id: options.feederId,
        source,
        payload: checked,
      });
      return ingestResultSchema.parse(json);
    },
    async completeRun(runId, completion) {
      await post(`${INGEST_RUNS_API_PATH}/${runId}/complete`, ingestRunCompletionSchema.parse(completion));
    },
    async runTask(task, request = {}) {
      const json = await post(`${INGEST_TASKS_API_PATH}/${task}`, ingestTaskRequestSchema.parse(request));
      return ingestTaskResultSchema.parse(json);
    },
    async recordManualCardPayment(request) {
      const json = await post(`${INGEST_TASKS_API_PATH}/${CC_MANUAL_PAYMENT_TASK}`, ccManualPaymentRequestSchema.parse(request));
      return ccManualPaymentResultSchema.parse(json);
    },
  };
}
