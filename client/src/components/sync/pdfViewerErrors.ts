/** What went wrong opening a PDF, as the viewer words it (never pdf.js's own text or the URL). */
export type PdfErrorKind = "missing" | "invalid" | "other";

/**
 * pdf.js rejects with its own exception classes, recognised by `name` (they cross from the
 * worker rebuilt, and a failed chunk load has no pdf.js module to compare against): a 404 answer
 * is a `ResponseException` with `status` 404, a file that is no PDF an `InvalidPDFException`.
 */
export function pdfErrorKind(e: unknown): PdfErrorKind {
  if (e == null || typeof e !== "object") return "other";
  const { name, status } = e as { name?: unknown; status?: unknown };
  if (name === "ResponseException" && status === 404) return "missing";
  if (name === "InvalidPDFException") return "invalid";
  return "other";
}

/** The translation key of each kind's message. */
export const PDF_ERROR_MESSAGE_KEYS: Record<PdfErrorKind, string> = {
  missing: "importSync.viewer.pdfMissing",
  invalid: "importSync.viewer.pdfInvalid",
  other: "importSync.viewer.pdfLoadFailed",
};
