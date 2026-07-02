/**
 * Tiny request-body validators for write endpoints. Every date the API accepts is
 * compared lexically downstream (`WHERE date <= ?`, `ORDER BY as_of_date`), and SQLite's
 * flexible typing will happily store a TEXT value in a REAL column — so validate BEFORE
 * any write, and 400 instead of persisting a poisoned row. Newer endpoints with richer
 * rules (movement create, mortgage payments) keep their dedicated validators.
 */

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `YYYY-MM-DD` string (format only — calendar validity is the DB layer's concern). */
export function isYmdString(v: unknown): v is string {
  return typeof v === "string" && YMD_RE.test(v);
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function isPositiveFiniteNumber(v: unknown): v is number {
  return isFiniteNumber(v) && v > 0;
}

export function isPositiveInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v > 0;
}

/** Optional string field: absent/null or a string (rejects numbers/objects). */
export function isOptionalString(v: unknown): v is string | null | undefined {
  return v == null || typeof v === "string";
}
