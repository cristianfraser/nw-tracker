import { normalizeMerchantText } from "nw-tracker-contracts";
import { buildExpenseKey } from "../expenseKeys.js";

/**
 * The expense key of a one-shot card line (not a cuota line): its parser row id when the parser gave
 * it one, else the card, merchant and purchase day. The one rule both a stored line
 * (`stableCcExpensePurchaseKeyFromCtx`) and an annulled purchase whose line is gone
 * (`cc_annulled_purchases`, which keeps the line's parser row id) read, so the purchase stays under
 * the key its category, note and big group were filed under.
 */
export function oneShotCardLineExpenseKey(args: {
  accountId: number;
  parserRowId: string | null | undefined;
  merchant: string | null | undefined;
  purchaseIso: string | null | undefined;
}): string {
  const parserRowId = String(args.parserRowId ?? "").trim();
  if (parserRowId && !parserRowId.startsWith("synthetic:")) {
    return buildExpenseKey({ kind: "line_pr", parserRowId });
  }
  return buildExpenseKey({
    kind: "line_fallback",
    accountId: args.accountId,
    merchantKey: normalizeMerchantText(args.merchant),
    purchaseIso: args.purchaseIso ?? "",
  });
}
