import fs from "node:fs";
import path from "node:path";
import express from "express";
import { repoRootFromSrc } from "./rootDotenv.js";

/**
 * `SERVE_CLIENT_DIST=1` — serve the built client (`client/dist`) from the API server so
 * a single web service hosts everything same-origin (hosted demo; no CORS involved).
 * Local mode leaves it unset: the Vite dev server owns the client and proxies `/api`.
 */
export function serveClientDistEnabled(): boolean {
  return process.env.SERVE_CLIENT_DIST === "1";
}

/**
 * Static client + SPA fallback. Register AFTER the API routes so `/api/*` is never
 * shadowed. The shared-password auth middleware lets non-`/api` paths through, so the SPA
 * shell + `/assets` load unauthenticated (they ship no personal data) and the client can
 * render the in-app `/login` page; data requests to `/api/*` stay gated by the session cookie.
 */
export function registerClientDistStatic(app: express.Express): void {
  const distDir = path.join(repoRootFromSrc(), "client", "dist");
  const indexHtml = path.join(distDir, "index.html");
  if (!fs.existsSync(indexHtml)) {
    throw new Error(
      `SERVE_CLIENT_DIST=1 but ${indexHtml} does not exist — run \`npm run build -w nw-tracker-client\` first.`
    );
  }
  // Vite content-hashes everything under /assets — cache immutable.
  app.use(
    "/assets",
    express.static(path.join(distDir, "assets"), { immutable: true, maxAge: "1y" })
  );
  app.use(express.static(distDir, { index: false }));
  // SPA fallback: any other non-API GET navigates to the client router. Missing /assets
  // files (stale HTML referencing an old hash) must 404, never return index.html.
  app.use((req, res, next) => {
    if (
      (req.method !== "GET" && req.method !== "HEAD") ||
      req.path === "/api" ||
      req.path.startsWith("/api/") ||
      req.path.startsWith("/assets/")
    ) {
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-cache");
    // `root` keeps send's dotfile check relative to distDir (an absolute path with a
    // dotted directory segment anywhere above it would otherwise 404).
    res.sendFile("index.html", { root: distDir });
  });
}
