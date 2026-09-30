import fs from "node:fs";
import path from "node:path";
import { createIngestClient, IngestRequestError, type IngestClient } from "nw-tracker-contracts";
import { resolveRepoRoot } from "./paths.js";

/** How this package names itself to the server (`feeder_id` on every payload). */
export const INGEST_FEEDER_ID = "nw-tracker-ingest";

const DEFAULT_SERVER_URL = "http://127.0.0.1:3001";

/**
 * `SERVER_URL` and `INGEST_TOKEN` from the environment, else from the repo-root `.env` the
 * server reads too (so a token set there reaches both sides). Nothing else is read from it.
 */
function envValue(key: string): string | undefined {
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

export function ingestClient(): IngestClient {
  const token = envValue("INGEST_TOKEN");
  return createIngestClient({
    baseUrl: resolveServerUrl(),
    feederId: INGEST_FEEDER_ID,
    ...(token ? { token } : {}),
  });
}

/** A request failure in words a run log can act on (a server that is down, or its refusal). */
export function describeIngestFailure(err: unknown): string {
  if (err instanceof IngestRequestError) return err.message;
  const cause = err instanceof Error && err.cause instanceof Error ? err.cause : null;
  if (cause && /ECONNREFUSED/.test(String((cause as NodeJS.ErrnoException).code ?? cause.message))) {
    return `the server is not reachable at ${resolveServerUrl()} — is com.user.nw-tracker-server running?`;
  }
  return err instanceof Error ? err.message : String(err);
}
