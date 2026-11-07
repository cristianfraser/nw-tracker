import type { RequestHandler } from "express";
import { ingestAccessRefusal, type IngestErrorBody } from "nw-tracker-contracts";

export { isLoopbackAddress } from "nw-tracker-contracts";

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
    const refusal = ingestAccessRefusal({
      remoteAddress: req.socket.remoteAddress,
      authorization: req.headers.authorization,
      token: config.token,
      allowRemote: config.allowRemote,
    });
    if (refusal) {
      refuse(refusal.status, {
        error: "ingest_forbidden",
        message: refusal.reason === "remote" ? "Ingest accepts local connections only." : "Missing or wrong ingest token.",
      });
      return;
    }
    next();
  };
}
