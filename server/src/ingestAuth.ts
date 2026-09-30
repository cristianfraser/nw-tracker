import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import type { IngestErrorBody } from "nw-tracker-contracts";

/**
 * Who may write through `/api/ingest/*`. Today: only this machine (the server binds
 * 127.0.0.1 anyway; the check keeps it that way if HOST is ever widened). Room to grow:
 * `INGEST_TOKEN` makes every request carry `Authorization: Bearer <token>`, and
 * `INGEST_ALLOW_REMOTE=1` — accepted only together with a token — lets a feeder on another
 * machine in. The hosted demo never accepts ingest.
 */
export interface IngestAuthConfig {
  token: string | null;
  allowRemote: boolean;
  demoMode: boolean;
}

export function ingestAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): IngestAuthConfig {
  const token = env.INGEST_TOKEN?.trim() || null;
  const allowRemote = env.INGEST_ALLOW_REMOTE === "1";
  if (allowRemote && !token) {
    throw new Error("INGEST_ALLOW_REMOTE=1 requires INGEST_TOKEN");
  }
  return { token, allowRemote, demoMode: env.DEMO_MODE === "1" };
}

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLoopbackAddress(address: string | undefined): boolean {
  return address != null && LOOPBACK_ADDRESSES.has(address);
}

function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? "");
  return m?.[1]?.trim() || null;
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function ingestAuthMiddleware(
  config: IngestAuthConfig = ingestAuthConfigFromEnv()
): RequestHandler {
  return (req, res, next) => {
    const refuse = (status: number, body: IngestErrorBody) => void res.status(status).json(body);
    if (config.demoMode) {
      refuse(403, { error: "ingest_disabled", message: "The demo does not accept data." });
      return;
    }
    // The socket's own address, never req.ip: a proxy header must not pass as local.
    if (!config.allowRemote && !isLoopbackAddress(req.socket.remoteAddress)) {
      refuse(403, { error: "ingest_forbidden", message: "Ingest accepts local connections only." });
      return;
    }
    if (config.token) {
      const given = bearerToken(req.headers.authorization);
      if (!given || !tokensEqual(given, config.token)) {
        refuse(401, { error: "ingest_forbidden", message: "Missing or wrong ingest token." });
        return;
      }
    }
    next();
  };
}
