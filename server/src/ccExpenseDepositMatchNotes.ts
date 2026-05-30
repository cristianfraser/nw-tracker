export const AUTO_DEPOSIT_MATCH_NOTE_PREFIX = "auto:deposit-match";

export type DepositMatchAllocation = {
  deposit: {
    occurred_on: string;
    amount_clp: number;
    account_id: number;
    category_slug: string;
    group_slug: string;
  };
  amount_clp: number;
};

export function formatAutoDepositMatchNote(
  matches: readonly DepositMatchAllocation[]
): string {
  const segments: string[] = [];
  for (const m of matches) {
    const amt = Math.round(m.amount_clp);
    if (amt <= 0) continue;
    segments.push(
      `acct:${m.deposit.account_id}|date:${m.deposit.occurred_on}|amt:${amt}`
    );
  }
  if (segments.length === 0) return "";
  return `${AUTO_DEPOSIT_MATCH_NOTE_PREFIX}|${segments.join("|")}`;
}

export function isAutoDepositMatchedPurchaseNote(note: string): boolean {
  return String(note ?? "").trimStart().startsWith(AUTO_DEPOSIT_MATCH_NOTE_PREFIX);
}

export type ParsedDepositMatchSegment = {
  account_id: number;
  occurred_on: string;
  amount_clp: number;
};

export function parseAutoDepositMatchNote(note: string): ParsedDepositMatchSegment[] {
  const text = String(note ?? "").trim();
  if (!text.startsWith(AUTO_DEPOSIT_MATCH_NOTE_PREFIX)) return [];
  const body = text.slice(AUTO_DEPOSIT_MATCH_NOTE_PREFIX.length);
  const segments: ParsedDepositMatchSegment[] = [];
  const re = /acct:(\d+)\|date:(\d{4}-\d{2}-\d{2})\|amt:(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) != null) {
    segments.push({
      account_id: Number(m[1]),
      occurred_on: m[2]!,
      amount_clp: Number(m[3]),
    });
  }
  return segments;
}

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

function extractUserNoteSuffix(note: string): string {
  const lines = note.split("\n");
  const first = lines[0]?.trim() ?? "";
  if (!isAutoDepositMatchedPurchaseNote(first)) return note.trim();
  const rest = lines.slice(1).join("\n").trim();
  return rest.replace(/^\n+/, "").trim();
}
