/** How a row entered the system (not where the API read it from). */
export type DataOrigin = "import_document" | "manual" | "api_sync";

export function dataOriginFromCcPurchaseSource(
  source: string | null | undefined
): DataOrigin {
  if (source === "manual") return "manual";
  return "import_document";
}

/** @deprecated Use `origin` on API DTOs. */
export type CcPurchaseSourceLegacy = "pdf" | "manual";

export function ccPurchaseSourceLegacyFromOrigin(origin: DataOrigin): CcPurchaseSourceLegacy {
  return origin === "manual" ? "manual" : "pdf";
}
