/**
 * pdf.js, loaded on first use (its own chunks: the library and the worker script) and shared by
 * every viewer after that. Nothing here imports pdf.js at module level, so the entry chunk and
 * the client tests never load it. The legacy build carries polyfills for what the modern one
 * calls natively (e.g. `Map.prototype.getOrInsertComputed`), which current Safari lacks.
 */
export type PdfjsModule = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let loading: Promise<PdfjsModule> | null = null;

export function loadPdfjs(): Promise<PdfjsModule> {
  loading ??= Promise.all([
    import("pdfjs-dist/legacy/build/pdf.mjs"),
    import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url"),
  ]).then(
    ([pdfjs, worker]) => {
      pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
      return pdfjs;
    },
    (e: unknown) => {
      // A failed chunk load (a deploy replaced it) is retried by the next viewer.
      loading = null;
      throw e;
    }
  );
  return loading;
}

/**
 * Where the build serves pdf.js's data files (client/scripts/vite-pdfjs-assets.mjs): the standard
 * fonts a PDF names without embedding, and the wasm image decoders (JPEG 2000, JBIG2 scans) and
 * colour profiles. Absolute, since the worker fetches them.
 */
export function pdfjsAssetUrl(dir: "standard_fonts" | "wasm" | "iccs"): string {
  return new URL(`${import.meta.env.BASE_URL}pdfjs/${dir}/`, window.location.href).href;
}
