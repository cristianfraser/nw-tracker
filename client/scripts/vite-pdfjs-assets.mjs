/**
 * pdf.js's data files, served from the installed `pdfjs-dist` under `/pdfjs/<dir>/` — by the
 * dev server from node_modules, and copied into the build (`dist/pdfjs/…`) — so no vendored copy
 * lives in git and the files always match the installed version. Read by
 * `src/components/sync/pdfjsLoader.ts` (`pdfjsAssetUrl`); fetched by the worker only when a PDF
 * needs them:
 *   - `standard_fonts/` — the fonts a PDF names without embedding them;
 *   - `wasm/` — the JPEG 2000 and JBIG2 image decoders (scanned statements) and the colour
 *     management module, with their no-wasm fallbacks; not QuickJS (PDF form scripting, unused);
 *   - `iccs/` — the CMYK profile the colour module reads.
 * The CJK character maps (`cmaps/`, 1.6 MB) are left out: they are only needed for East Asian
 * text in fonts the PDF does not embed.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const PDFJS_DIR = path.dirname(require.resolve("pdfjs-dist/package.json"));

/** Served folder → which of its files are served. */
const DIRS = {
  standard_fonts: () => true,
  wasm: (file) => !file.startsWith("quickjs"),
  iccs: () => true,
};

const CONTENT_TYPES = {
  ".wasm": "application/wasm",
  ".js": "text/javascript",
  ".ttf": "font/ttf",
};

function servedFiles() {
  return Object.entries(DIRS).flatMap(([dir, keep]) =>
    fs
      .readdirSync(path.join(PDFJS_DIR, dir))
      .filter(keep)
      .map((file) => ({ dir, file, abs: path.join(PDFJS_DIR, dir, file) }))
  );
}

/** @returns {import("vite").Plugin} */
export function pdfjsAssets() {
  return {
    name: "nw-tracker-pdfjs-assets",
    configureServer(server) {
      const byPath = new Map(servedFiles().map((f) => [`/${f.dir}/${f.file}`, f.abs]));
      server.middlewares.use("/pdfjs", (req, res, next) => {
        const abs = byPath.get((req.url ?? "").split("?")[0]);
        if (!abs) return next();
        res.setHeader("Content-Type", CONTENT_TYPES[path.extname(abs)] ?? "application/octet-stream");
        fs.createReadStream(abs).pipe(res);
      });
    },
    generateBundle() {
      for (const { dir, file, abs } of servedFiles()) {
        this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: fs.readFileSync(abs) });
      }
    },
  };
}
