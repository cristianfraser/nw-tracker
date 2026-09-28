/**
 * Purchase key of the synthetic checking-side gastos line a `checking_gap_deposit_mirrors` row
 * renders as. Leaf module (no imports) so the purchase-key resolver, the link sync and the mirror
 * writers share one spelling without an import cycle.
 */
export const CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX = "synthetic-checking-gap-mirror:";

export function checkingGapDepositMirrorPurchaseKey(mirrorId: number): string {
  return `${CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX}${mirrorId}`;
}

export function isCheckingGapDepositMirrorPurchaseKey(purchaseKey: string): boolean {
  return purchaseKey.startsWith(CHECKING_GAP_DEPOSIT_MIRROR_PURCHASE_KEY_PREFIX);
}
