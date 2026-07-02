import { parseCartolaAmount } from "./checkingCartolaParse.js";
import type { UltimosMovimientoRow } from "./checkingUltimosMovimientosParse.js";

export type CuentaVistaWebPasteParseResult = {
  movements: UltimosMovimientoRow[];
  errors: string[];
};

/** `dd/mm/yyyy`, `dd-mm-yyyy`, or `yyyy-mm-dd` → ISO. Year is required (cartola prints only
 * `dd/mm`; guessing the year would misfile rows pasted near January). */
function parsePasteDate(raw: string): string | null {
  const t = raw.trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const mo = Number(iso[2]);
    const d = Number(iso[3]);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return t;
  }
  const ddmm = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t);
  if (!ddmm) return null;
  const d = Number(ddmm[1]);
  const mo = Number(ddmm[2]);
  const y = Number(ddmm[3]);
  if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function normalizeDescription(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 180);
}

/**
 * Parse cuenta vista movements pasted into the account-page textarea. One movement per line,
 * fields separated by `;` or tabs:
 *
 * - `fecha; descripción; monto` — signed CLP, negative = cargo (`15/06/2026; Traspaso a Cta. Cte.; -5.000`)
 * - `fecha; descripción; cargo; abono` — exactly one of the two amount columns set
 *
 * Invalid lines are reported in `errors` (no guessing — a line either parses fully or is rejected).
 */
export function parseCuentaVistaWebPasteText(text: string): CuentaVistaWebPasteParseResult {
  const movements: UltimosMovimientoRow[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Split the raw line, not the trimmed one: a trailing separator is an intentionally empty
    // 4th column (cargo set, abono blank) and must not collapse the line to 3 fields.
    const parts = rawLine.split(/[;\t]/).map((p) => p.trim());
    if (parts.length < 3 || parts.length > 4) {
      errors.push(
        `Línea con ${parts.length} campo(s), se esperan 3 (fecha; descripción; monto) o 4 (fecha; descripción; cargo; abono): ${line.slice(0, 80)}`
      );
      continue;
    }

    const occurred_on = parsePasteDate(parts[0]!);
    if (!occurred_on) {
      errors.push(`Fecha inválida (usa dd/mm/aaaa): ${parts[0] || "vacía"}`);
      continue;
    }

    const description = normalizeDescription(parts[1]!);
    if (!description) {
      errors.push(`Descripción vacía: ${line.slice(0, 80)}`);
      continue;
    }

    let amount_clp: number;
    if (parts.length === 3) {
      const n = parseCartolaAmount(parts[2]!);
      if (n == null || n === 0) {
        errors.push(`Monto inválido (${parts[2] || "vacío"}): ${description}`);
        continue;
      }
      amount_clp = n;
    } else {
      const cargo = parts[2] ? parseCartolaAmount(parts[2]) : null;
      const abono = parts[3] ? parseCartolaAmount(parts[3]) : null;
      const hasCargo = cargo != null && cargo !== 0;
      const hasAbono = abono != null && abono !== 0;
      if (hasCargo === hasAbono) {
        errors.push(
          `Debe venir cargo o abono (solo uno): ${description} (cargo=${parts[2] || "—"}, abono=${parts[3] || "—"})`
        );
        continue;
      }
      amount_clp = hasCargo ? -Math.abs(cargo!) : Math.abs(abono!);
    }

    const docMatch = /^(\d+)\s/.exec(description);
    const document_no = docMatch?.[1] ?? "";

    const key = `${occurred_on}\t${amount_clp}\t${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    movements.push({ occurred_on, description, amount_clp, document_no });
  }

  return { movements, errors };
}
