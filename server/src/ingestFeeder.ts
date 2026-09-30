import {
  FEEDER_PARSE_PATH,
  feederParseErrorSchema,
  feederParseRequestSchema,
  feederParseResultSchema,
  type FeederParseFormat,
  type FeederParseResult,
} from "nw-tracker-contracts";

/** The ingest service's base URL (`INGEST_URL`). */
export function resolveIngestServiceUrl(env: NodeJS.ProcessEnv = process.env): string {
  return (env.INGEST_URL?.trim() || "http://127.0.0.1:3002").replace(/\/+$/, "");
}

export function ingestFeederHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = env.INGEST_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

export type FeederParseAnswer =
  | { status: "parsed"; result: FeederParseResult }
  | { status: "not_this_format"; message: string }
  | { status: "unreadable"; message: string }
  | { status: "unavailable"; message: string };

const PARSE_TIMEOUT_MS = 60_000;

/**
 * Hand an uploaded file to the ingest service to decode (`POST /parse/<format>`): the server
 * never reads a bank's own format. Never throws for the service's answers; `unavailable` when
 * the service does not answer (it runs as the `com.user.nw-tracker-ingest` LaunchAgent).
 */
export async function requestFeederParse(
  format: FeederParseFormat,
  content: Buffer,
  filename: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<FeederParseAnswer> {
  let res: Response;
  try {
    res = await fetch(`${resolveIngestServiceUrl(env)}${FEEDER_PARSE_PATH}/${format}`, {
      method: "POST",
      headers: ingestFeederHeaders(env),
      body: JSON.stringify(feederParseRequestSchema.parse({ filename, content_base64: content.toString("base64") })),
      signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
    });
  } catch (err) {
    return {
      status: "unavailable",
      message: `the ingest service at ${resolveIngestServiceUrl(env)} did not answer (${err instanceof Error ? err.message : String(err)})`,
    };
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (res.ok) return { status: "parsed", result: feederParseResultSchema.parse(json) };
  const refused = feederParseErrorSchema.safeParse(json);
  if (res.status === 422 && refused.success) return { status: refused.data.error, message: refused.data.message };
  throw new Error(`ingest /parse/${format} answered HTTP ${res.status}: ${text.slice(0, 300)}`);
}
