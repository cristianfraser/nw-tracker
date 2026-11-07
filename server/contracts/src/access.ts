import { timingSafeEqual } from "node:crypto";

/**
 * Who may talk to the two ingest endpoints — the server's `/api/ingest/*` and the ingest
 * service's `/runs` and `/parse` — and where each listens by default. One rule on both sides:
 * local connections only (the socket's own address, never a proxy header), unless a remote
 * feeder is allowed, and the bearer token when one is configured.
 */

/** The server's default port (`PORT`). */
export const DEFAULT_SERVER_PORT = 3001;
/** The ingest service's default port (`INGEST_SERVICE_PORT`). */
export const DEFAULT_INGEST_SERVICE_PORT = 3002;

export const DEFAULT_SERVER_URL = `http://127.0.0.1:${DEFAULT_SERVER_PORT}`;
export const DEFAULT_INGEST_SERVICE_URL = `http://127.0.0.1:${DEFAULT_INGEST_SERVICE_PORT}`;

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address != null && LOOPBACK_ADDRESSES.has(address);
}

/** Whether `Authorization: Bearer <token>` names `token` (constant-time). */
export function bearerTokenMatches(authorization: string | undefined, token: string): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(authorization ?? "")?.[1]?.trim();
  if (!given) return false;
  const x = Buffer.from(given);
  const y = Buffer.from(token);
  return x.length === y.length && timingSafeEqual(x, y);
}

export type IngestAccessRefusal = { status: 401 | 403; reason: "remote" | "token" };

/** Null when the request may pass; else why not. */
export function ingestAccessRefusal(request: {
  remoteAddress: string | undefined;
  authorization: string | undefined;
  token: string | null;
  allowRemote: boolean;
}): IngestAccessRefusal | null {
  if (!request.allowRemote && !isLoopbackAddress(request.remoteAddress)) return { status: 403, reason: "remote" };
  if (request.token && !bearerTokenMatches(request.authorization, request.token)) return { status: 401, reason: "token" };
  return null;
}
