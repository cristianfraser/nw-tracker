import { execFileSync } from "node:child_process";
import fs from "node:fs";

/** Matches Santander `** CARTOLA SIN MOVIMIENTOS **` in cartola PDF text. */
export const CARTOLA_SIN_MOVIMIENTOS_RE =
  /\*\*\s*CARTOLA\s+SIN\s+MOVIMIENTOS\s*\*\*/i;

export function textIndicatesCartolaSinMovimientos(text: string): boolean {
  return CARTOLA_SIN_MOVIMIENTOS_RE.test(String(text ?? ""));
}

/** Peek PDF text via pdftotext; returns false when unreadable or tool missing. */
export function cartolaPdfIndicatesSinMovimientos(filePath: string): boolean {
  const abs = String(filePath ?? "").trim();
  if (!abs || !fs.existsSync(abs)) return false;
  try {
    const text = execFileSync("pdftotext", [abs, "-"], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    return textIndicatesCartolaSinMovimientos(text);
  } catch {
    return false;
  }
}

/** Higher score = prefer this PDF for the month (coverage matrix / path merge). */
export function cartolaPdfPreferenceScore(
  filePath: string,
  movementCount = 0
): number {
  if (cartolaPdfIndicatesSinMovimientos(filePath)) return 0;
  return 1_000_000 + Math.max(0, movementCount);
}
