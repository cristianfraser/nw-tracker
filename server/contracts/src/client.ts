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

export interface IngestClient {
  /**
   * Validates `payload` against the kind's schema here (a malformed document fails in the
   * feeder, before any request), sends it, and returns what the server did. Throws
   * `IngestRequestError` on a refusal and on a server error.
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
  /** POST a JSON body; the parsed response body, or IngestRequestError on a non-2xx answer. */
  async function post(pathname: string, body: unknown): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    const res = await doFetch(`${base}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) });
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
