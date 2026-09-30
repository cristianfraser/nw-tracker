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
}

export function createIngestClient(options: IngestClientOptions): IngestClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  return {
    async send(kind, payload, source) {
      const checked = kind.payload.parse(payload);
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.token) headers.authorization = `Bearer ${options.token}`;
      const res = await doFetch(`${base}${INGEST_API_PATH}/${kind.kind}`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          schema_version: kind.schema_version,
          feeder_id: options.feederId,
          source,
          payload: checked,
        }),
      });
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
      return ingestResultSchema.parse(json);
    },
  };
}
