import type { NextFunction, Request, Response } from "express";
import { logHttpInEnabled, logServer } from "./serverLog.js";

function requestLine(req: Request): string {
  const path = req.originalUrl || req.url;
  return `${req.method} ${path}`;
}

/** Log every incoming HTTP request when `DEBUG_HTTP=1` or `DEBUG_VERBOSE=1`. */
export function httpRequestLogMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!logHttpInEnabled()) {
    next();
    return;
  }
  const t0 = performance.now();
  const line = requestLine(req);
  logServer("api", `--> ${line}`);
  res.on("finish", () => {
    const ms = (performance.now() - t0).toFixed(1);
    logServer("api", `<-- ${line} ${res.statusCode} ${ms}ms`);
  });
  next();
}
