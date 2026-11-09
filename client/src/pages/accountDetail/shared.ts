export const MONTHLY_PERF_COLLAPSED = 12;

/** Inmueble Depto (`real_estate` nav bucket or `property` kind). */
export function isDeptoPropertyCategory(categorySlug: string | null | undefined): boolean {
  return categorySlug === "property" || categorySlug === "real_estate";
}

export function isDeptoMortgageCategory(categorySlug: string | null | undefined): boolean {
  return categorySlug === "mortgage";
}
