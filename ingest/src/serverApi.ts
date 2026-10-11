import fs from "node:fs";
import path from "node:path";
import {
  connectionFailureCode,
  createIngestClient,
  IngestConnectionError,
  IngestRequestError,
  type IngestClient,
} from "nw-tracker-contracts";
import { log } from "./log.js";
import { resolveRepoRoot } from "./paths.js";

/** How this package names itself to the server (`feeder_id` on every payload). */
export const INGEST_FEEDER_ID = "nw-tracker-ingest";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3001";

/**
 * `SERVER_URL` and `INGEST_TOKEN` from the environment, else from the repo-root `.env` the
 * server reads too (so a token set there reaches both sides). Nothing else is read from it.
 */
export function envValue(key: string): string | undefined {
  const fromEnv = process.env[key]?.trim();
  if (fromEnv) return fromEnv;
  const file = path.join(resolveRepoRoot(), ".env");
  if (!fs.existsSync(file)) return undefined;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m?.[1] !== key) continue;
    const raw = m[2] ?? "";
    return raw.replace(/^(['"])(.*)\1$/, "$2") || undefined;
  }
  return undefined;
}

export function resolveServerUrl(): string {
  return envValue("SERVER_URL") ?? DEFAULT_SERVER_URL;
}

/**
 * The server client every command and the service send through. A request the server never
 * answered (refused, reset, cut by a restart mid-request) is retried by the client; each retry
 * is logged here so the run log shows what it rode out.
 */
export function ingestClient(): IngestClient {
  const token = envValue("INGEST_TOKEN");
  const url = resolveServerUrl();
  return createIngestClient({
    baseUrl: url,
    feederId: INGEST_FEEDER_ID,
    ...(token ? { token } : {}),
    onRetry: ({ pathname, code, attempt, delayMs }) =>
      log(`server: no answer from ${url} for ${pathname} (${code}) on attempt ${attempt}; retrying in ${delayMs / 1000} s`),
  });
}

/** A request failure in words a run log can act on: a server that is down, that never answered, or its refusal. */
export function describeIngestFailure(err: unknown): string {
  if (err instanceof IngestRequestError) return err.message;
  if (err instanceof IngestConnectionError) {
    const tried = `${err.attempts} attempt(s) over ${Math.round(err.elapsedMs / 1000)} s`;
    return err.code === "ECONNREFUSED"
      ? `the server is not reachable at ${err.baseUrl} (${tried}) — is com.user.nw-tracker-server running?`
      : `the server at ${err.baseUrl} did not answer (${err.code}; ${tried})`;
  }
  const code = connectionFailureCode(err);
  if (code != null) return `connection failed (${code}): ${err instanceof Error ? err.message : String(err)}`;
  return err instanceof Error ? err.message : String(err);
}
