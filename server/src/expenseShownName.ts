/**
 * The one name a row shows (`ShownName`) and the bank's text behind it (`ShownNameDetail`, the ⓘ
 * card's), from the names the expense pipeline derived: a card payment's name
 * (`expensePaymentNames.ts`) over a refund's wording over the display name
 * (`expenseDisplayNames.ts`) over the bank's text. Every DTO that names a bank movement or card line
 * takes its name from here, so no client picks between a pretty and a raw name. A leaf: structural
 * types only.
 */
import type { ExpenseLinePaymentName, ShownName, ShownNameBase, ShownNameDetail } from "nw-tracker-contracts/dto/flows";

/** The names a line or movement carries inside the server. */
export type ShownNameSource = {
  merchant: string | null;
  display_merchant?: string;
  payment_name?: ExpenseLinePaymentName;
  merchant_processor?: string;
};

export type ShownNameFields = { name: ShownName; name_detail?: ShownNameDetail };

function requireText(source: ShownNameSource, what: string): string {
  const text = source.display_merchant ?? source.merchant?.trim();
  if (!text) throw new Error(`${what} has no name: no display name and no bank text`);
  return text;
}

function baseName(source: ShownNameSource, what: string): ShownNameBase {
  return source.payment_name ?? { kind: "text", text: requireText(source, what) };
}

/**
 * A line's shown name and its ⓘ provenance. `refundOf` = the purchase a refund refunds (its names as
 * its line finally reads); the refund then reads as that purchase's.
 */
export function shownNameFields(source: ShownNameSource, what: string, refundOf?: ShownNameSource): ShownNameFields {
  const name: ShownName = refundOf
    ? { kind: "refund_of", purchase: baseName(refundOf, `${what} (refunded purchase)`) }
    : baseName(source, what);
  const bank = source.merchant?.trim() || null;
  if (bank == null || (name.kind === "text" && name.text === bank && !source.merchant_processor)) return { name };
  const detail: ShownNameDetail = { bank_text: bank };
  // A payment's name or a refund's wording took the store's name's place: the ⓘ card keeps it.
  if (name.kind !== "text" && source.display_merchant != null && source.display_merchant !== bank) {
    detail.store_name = source.display_merchant;
  }
  if (source.merchant_processor) detail.processor = source.merchant_processor;
  return { name, name_detail: detail };
}

/** A name that is only text (a manual income's source, a flows row's own note), with no bank text behind it. */
export function textShownName(text: string): ShownName {
  return { kind: "text", text };
}

/** The words of a shown name a text search matches: its text, or what a payment or refund names. */
export function shownNameSearchText(name: ShownName): string {
  switch (name.kind) {
    case "text":
      return name.text;
    case "pays_card":
    case "paid_by_card":
      return `${name.card_brand} ${name.card_last4}`;
    case "paid_from_account":
      return name.account_name;
    case "refund_of":
      return shownNameSearchText(name.purchase);
  }
}

/**
 * The bank's text of a line as the wire sends it, for server scripts and tests that read wire lines:
 * the ⓘ provenance when the name is another, else the name itself.
 */
export function wireLineBankText(l: { name: ShownName; name_detail?: ShownNameDetail }): string | null {
  return l.name_detail?.bank_text ?? (l.name.kind === "text" ? l.name.text : null);
}
