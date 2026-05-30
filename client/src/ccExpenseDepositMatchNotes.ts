export const AUTO_DEPOSIT_MATCH_NOTE_PREFIX = "auto:deposit-match";

export function isAutoDepositMatchedPurchaseNote(note: string): boolean {
  return String(note ?? "").trimStart().startsWith(AUTO_DEPOSIT_MATCH_NOTE_PREFIX);
}
