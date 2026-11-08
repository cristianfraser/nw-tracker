export const AUTO_DEPOSIT_MATCH_NOTE_PREFIX = "auto:deposit-match";

export type DepositMatchAllocation = {
  deposit: {
    occurred_on: string;
    amount_clp: number;
    account_id: number;
    category_slug: string;
    group_slug: string;
    /** The deposit's movement row when it is one (twin deposits share account, day and pesos). */
    movement_id: number | null;
  };
  amount_clp: number;
};

/** The matcher's result as data: one segment per deposit that took pesos of the outflow. */
export function depositMatchSegments(matches: readonly DepositMatchAllocation[]): ParsedDepositMatchSegment[] {
  const out: ParsedDepositMatchSegment[] = [];
  for (const m of matches) {
    const amt = Math.round(m.amount_clp);
    if (amt <= 0) continue;
    out.push({
      account_id: m.deposit.account_id,
      occurred_on: m.deposit.occurred_on,
      amount_clp: amt,
      movement_id: m.deposit.movement_id,
    });
  }
  return out;
}

/**
 * The matcher's result worded for the line's note, which the Expenses page still shows (and the
 * client still reads to list deposit-matched lines). Nothing on the server parses it back: links
 * read `deposit_match`.
 */
export function formatAutoDepositMatchNote(segments: readonly ParsedDepositMatchSegment[]): string {
  if (segments.length === 0) return "";
  const parts = segments.map(
    (s) => `acct:${s.account_id}|date:${s.occurred_on}|amt:${s.amount_clp}${s.movement_id != null ? `|mov:${s.movement_id}` : ""}`
  );
  return `${AUTO_DEPOSIT_MATCH_NOTE_PREFIX}|${parts.join("|")}`;
}

export function isAutoDepositMatchedPurchaseNote(note: string): boolean {
  return String(note ?? "").trimStart().startsWith(AUTO_DEPOSIT_MATCH_NOTE_PREFIX);
}

export type ParsedDepositMatchSegment = {
  account_id: number;
  occurred_on: string;
  amount_clp: number;
  /** Present when the matcher named the deposit's movement row (notes written before carry none). */
  movement_id: number | null;
};

/** Replace stale auto line; preserve user suffix after blank line. */
export function mergeAutoDepositMatchNote(
  existingDbNote: string,
  autoNote: string
): string {
  const auto = String(autoNote ?? "").trim();
  if (!auto) return String(existingDbNote ?? "").trim();

  const existing = String(existingDbNote ?? "").trim();
  if (!existing) return auto;
  if (isAutoDepositMatchedPurchaseNote(existing)) {
    const suffix = extractUserNoteSuffix(existing);
    return suffix ? `${auto}\n\n${suffix}` : auto;
  }
  return `${auto}\n\n${existing}`;
}

/** A stored note without the matcher's line (what the user wrote after it). */
export function extractUserNoteSuffix(note: string): string {
  const lines = note.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!isAutoDepositMatchedPurchaseNote(first)) return note.trim();
  const rest = lines.slice(1).join("\n").trim();
  return rest.replace(/^\n+/, "").trim();
}
