/**
 * The machine note an additional cardholder's purchase carries (`auto:additional-card|…`) and how
 * it merges with the user's own note. Text only (a leaf: no database).
 */
export const AUTO_ADDITIONAL_CARD_NOTE_PREFIX = "auto:additional-card";

export function formatAutoAdditionalCardNote(opts: {
  originLast4: string;
  primaryLast4: string;
}): string {
  return `${AUTO_ADDITIONAL_CARD_NOTE_PREFIX}|origin:${opts.originLast4}|stmt:${opts.primaryLast4}`;
}

export function isAutoAdditionalCardPurchaseNote(note: string): boolean {
  return String(note ?? "").trimStart().startsWith(AUTO_ADDITIONAL_CARD_NOTE_PREFIX);
}

function extractUserNoteSuffix(note: string): string {
  const lines = note.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!isAutoAdditionalCardPurchaseNote(first)) return note.trim();
  const rest = lines.slice(1).join("\n").trim();
  return rest.replace(/^\n+/, "").trim();
}

/** Replace stale auto line; preserve user suffix after blank line. */
export function mergeAutoAdditionalCardNote(
  existingDbNote: string,
  autoNote: string
): string {
  const auto = String(autoNote ?? "").trim();
  if (!auto) return String(existingDbNote ?? "").trim();

  const existing = String(existingDbNote ?? "").trim();
  if (!existing) return auto;
  if (isAutoAdditionalCardPurchaseNote(existing)) {
    const suffix = extractUserNoteSuffix(existing);
    return suffix ? `${auto}\n\n${suffix}` : auto;
  }
  return `${auto}\n\n${existing}`;
}
