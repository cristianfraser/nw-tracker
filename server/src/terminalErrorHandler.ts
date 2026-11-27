import type express from "express";
import { DisplayUnitRequestError } from "./displayUnits.js";
import { InputError } from "./inputError.js";

/**
 * The last middleware: a route throw (or rejection) answers JSON instead of Express's HTML stack
 * page, and the process stays up. A request the user can fix, thrown outside `writeHandler` (a
 * display unit, a route's `parseBody`, a documents request), answers its own status; anything else 500.
 */
export function terminalErrorHandler(
  err: unknown,
  _req: express.Request,
  res: express.Response,
  _next: express.NextFunction
): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[api] route error: ${err instanceof Error ? (err.stack ?? msg) : msg}`);
  if (res.headersSent) return;
  if (err instanceof DisplayUnitRequestError || err instanceof InputError) {
    res.status(err.status).json({ error: msg });
    return;
  }
  res.status(500).json({ error: msg });
}
