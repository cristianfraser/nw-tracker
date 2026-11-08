/**
 * Reading the stored card-line kind (`cc_statement_lines.kind`, migration 276). The kind is decided
 * once, when the line is written, by the one classifier (`cardLineKind` in `nw-tracker-contracts`,
 * `cards/lineRules.ts`) every source applies when it converts a line to the canonical card line;
 * readers read it here. What depends on context — the installment mode, a nota de crédito paired
 * with the purchase it annuls, the user's category, the modal section — stays with the reader.
 */
import type { CardLineKind } from "nw-tracker-contracts";
import { isCardLineKind } from "nw-tracker-contracts";

/** A stored kind, read back: anything that is not one of `CARD_LINE_KINDS` is bad stored state. */
export function requireStoredCardLineKind(value: unknown, lineId: number): CardLineKind {
  if (!isCardLineKind(value)) {
    throw new Error(`cc_statement_lines ${lineId}: kind ${JSON.stringify(value ?? null)} is not a card line kind`);
  }
  return value;
}

/** The kinds that pay or move the card's own debt — never spending. */
export function isCardDebtSettlementKind(kind: CardLineKind): boolean {
  return kind === "card_payment" || kind === "card_debt_transfer";
}
