/**
 * Text pasted from a card issuer's web table («últimos movimientos» / unbilled movements) →
 * `card.pasted_listing` (moved from the server's `ccWebPasteParse.ts`). Tab-separated cells: a
 * date printed once per day (the rows under it inherit it), the merchant, the amount. Amounts and
 * merchants stay as printed; the server applies the issuer's sign rules and its own merchant
 * normalization.
 */
import { CARD_PASTED_LISTING, type CardPastedListing, type FeederParseResult } from "nw-tracker-contracts";
import { parseDdMmYyToIso } from "../formats/ddMmYy.js";

/** USD indicators the bank web-UI uses in the amount column (`USD`, `US$`, `U$`, `U$S`). */
const USD_TOKEN_RE = /US\$|USD|U\$S?/i;
const AMOUNT_RE = /([+-]?)\$?([\d.,]+)/;

export type WebPasteAmount = { amount: number; currency: "clp" | "usd" };

/**
 * A pasted amount token → signed amount + currency. A `USD` / `US$` token marks a dollar charge
 * read with Chilean decimals (`99,28` → 99.28); otherwise pesos with `.` as thousands separator
 * (`1.990` → 1990). Null for an empty, zero or unreadable token.
 */
export function parseWebPasteAmountToken(raw: string): WebPasteAmount | null {
  const t = String(raw ?? "").trim();
  if (!t) return null;
  const isUsd = USD_TOKEN_RE.test(t);
  const cleaned = t.replace(/\s+/g, "").replace(USD_TOKEN_RE, "");
  const m = AMOUNT_RE.exec(cleaned);
  if (!m) return null;
  const sign = m[1] === "-" ? -1 : 1;
  if (isUsd) {
    const num = Number(m[2]!.replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(num) || num === 0) return null;
    return { amount: sign * num, currency: "usd" };
  }
  const n = Number(m[2]!.replace(/[.,]/g, ""));
  if (!Number.isFinite(n) || n === 0) return null;
  return { amount: sign * Math.round(n), currency: "clp" };
}

export function parseWebPasteText(text: string): CardPastedListing {
  const lines: CardPastedListing["lines"] = [];
  const errors: string[] = [];
  let currentDate: string | null = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/\t+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) continue;

    let idx = 0;
    const maybeDate = parts[0]!.trim() ? parseDdMmYyToIso(parts[0]!.trim()) : null;
    if (maybeDate) {
      currentDate = maybeDate;
      idx = 1;
    }
    if (!currentDate) {
      errors.push(`Sin fecha para línea: ${line.slice(0, 80)}`);
      continue;
    }

    let merchant = "";
    let amountRaw = "";
    if (parts.length - idx >= 2) {
      merchant = parts[idx]!;
      amountRaw = parts[idx + 1]!;
    } else if (parts.length - idx === 1) {
      const only = parts[idx]!;
      const amtAtEnd = /\s+([+-]?\s*(?:US\$|USD|U\$S?)?\s*\$?[\d.,]+)\s*$/i.exec(only);
      if (amtAtEnd) {
        merchant = only.slice(0, amtAtEnd.index).trim();
        amountRaw = amtAtEnd[1]!;
      } else {
        merchant = only;
      }
    }
    if (!merchant) {
      errors.push(`Sin comercio: ${line.slice(0, 80)}`);
      continue;
    }
    const parsed = parseWebPasteAmountToken(amountRaw);
    if (parsed == null) {
      errors.push(`Monto inválido (${amountRaw || "vacío"}): ${merchant}`);
      continue;
    }
    lines.push({ date: currentDate, merchant, amount: parsed.amount, currency: parsed.currency, raw_line: line });
  }
  return { lines, errors };
}

/** `POST /parse/card.web_paste`: the pasted text, UTF-8. */
export function parseCardWebPaste(content: Buffer): FeederParseResult {
  return { ...CARD_PASTED_LISTING, payload: parseWebPasteText(content.toString("utf8")) };
}
