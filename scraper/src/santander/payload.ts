/**
 * Santander's API mixes key casing between endpoints (`Cabecera`/`Entrada` on the movements call,
 * `cabecera`/`INPUT` on the statement one), so every lookup here is case-insensitive.
 */
export function pick(obj: unknown, ...keys: string[]): unknown {
  if (typeof obj !== "object" || obj === null) return undefined;
  const entries = Object.entries(obj as Record<string, unknown>);
  for (const key of keys) {
    const hit = entries.find(([k]) => k.toLowerCase() === key.toLowerCase());
    if (hit) return hit[1];
  }
  return undefined;
}

export function pickString(obj: unknown, ...keys: string[]): string | null {
  const value = pick(obj, ...keys);
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

/**
 * Success is reported at two levels and BOTH must be checked.
 *
 * `METADATA.STATUS` is the gateway's verdict; the backend's own result hides in
 * `DATA.Informacion.Codigo` (or `INFO.CODERR`). A backend timeout comes back as HTTP 200 with
 * `METADATA.STATUS: "0"` and `Informacion.Codigo: "16"` — checking only the outer status reports a
 * failed call as a successful one (observed 2026-08-04 on the statement-PDF endpoint).
 */
export function assertApiOk(responseBody: unknown, endpoint: string): void {
  const metadata = pick(responseBody, "METADATA");
  const status = pickString(metadata, "STATUS");
  if (status === null) throw new Error(`${endpoint}: response has no METADATA.STATUS`);
  if (status !== "0") {
    const description = pickString(metadata, "DESCRIPCION") ?? "(no description)";
    throw new Error(`${endpoint}: API returned STATUS ${status} — ${description}`);
  }
  const inner = innerResultCode(responseBody);
  if (inner && inner.code !== "00" && inner.code !== "0") {
    throw new Error(`${endpoint}: backend returned ${inner.code} — ${inner.message}`);
  }
}

/** The backend result buried under `DATA`, whichever envelope this endpoint uses. */
export function innerResultCode(responseBody: unknown): { code: string; message: string } | null {
  const data = pick(responseBody, "DATA");
  const informacion = pick(data, "Informacion");
  const code = pickString(informacion, "Codigo");
  if (code !== null) {
    const message = pickString(informacion, "Mensaje") ?? pickString(informacion, "Resultado") ?? "";
    return { code, message };
  }
  // `AS_TIB_*` envelopes report through INFO.CODERR instead.
  for (const value of Object.values((data as Record<string, unknown>) ?? {})) {
    const info = pick(value, "INFO");
    const coderr = pickString(info, "CODERR");
    if (coderr !== null) {
      return { code: coderr, message: pickString(info, "MSGUSUARIO") ?? pickString(info, "DESERR") ?? "" };
    }
  }
  return null;
}

/**
 * "SALDO INICIAL" is the previous period's billed total, not a movement of this period — the one
 * row that must never reach the ledger.
 */
export function isSaldoInicialRow(row: unknown): boolean {
  const description = pickString(row, "Descripcion") ?? "";
  return /^\s*saldo\s+inicial\s*$/i.test(description);
}
