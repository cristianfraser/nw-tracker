import fs from "node:fs";
import path from "node:path";
import { repoRootFromSrc } from "./rootDotenv.js";
import { serveClientDistEnabled } from "./staticClientDist.js";

/**
 * Which client build this server serves, so an open tab can tell it is running an older one
 * (the client polls it on `/api/live-quotes/stamp` and reloads, see client/src/clientBuild.ts).
 *
 * The id is the content-hashed `/assets/` URLs `client/dist/index.html` loads (entry script and
 * stylesheet), sorted and space-joined — the client reads the same URLs from its own document.
 * A deploy that changes no client file keeps the id, so a server-only deploy reloads no tab.
 */
export function clientBuildIdFromAssetUrls(urls: readonly string[]): string | null {
  const assets = [...new Set(urls.filter((u) => u.startsWith("/assets/")))].sort();
  return assets.length === 0 ? null : assets.join(" ");
}

/** The entry `<script src>` and `<link rel="stylesheet" href>` URLs of a built index.html. */
export function clientBuildIdFromIndexHtml(html: string): string | null {
  const urls: string[] = [];
  for (const m of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /\bsrc="([^"]+)"/i.exec(m[0]);
    if (src) urls.push(src[1]!);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel="stylesheet"/i.test(m[0])) continue;
    const href = /\bhref="([^"]+)"/i.exec(m[0]);
    if (href) urls.push(href[1]!);
  }
  return clientBuildIdFromAssetUrls(urls);
}

let cached: { mtimeMs: number; size: number; id: string | null } | null = null;

/**
 * The served build's id, or null when this server serves no client (the Vite dev server owns
 * it). Read from disk, cached on the file's mtime and size: the deploy swaps `client/dist` in
 * place before it restarts the server.
 */
export function servedClientBuildId(): string | null {
  if (!serveClientDistEnabled()) return null;
  const indexHtml = path.join(repoRootFromSrc(), "client", "dist", "index.html");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(indexHtml);
  } catch (e) {
    // The deploy swaps the build with two renames; between them there is no index.html.
    // That instant states no build (the next poll does), it is not a broken install.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.id;
  const id = clientBuildIdFromIndexHtml(fs.readFileSync(indexHtml, "utf8"));
  if (id == null) throw new Error(`${indexHtml} loads no /assets/ script or stylesheet`);
  cached = { mtimeMs: stat.mtimeMs, size: stat.size, id };
  return id;
}
