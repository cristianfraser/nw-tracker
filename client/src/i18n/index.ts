import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { readInitialLanguage } from "../languagePreference";
import type { DepositFlowCategory, FlowsPlBucketSlug, ShownName, ShownNameBase } from "../types";
import en from "./locales/en.json";
import es from "./locales/es.json";

void i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
    en: { translation: en },
  },
  lng: readInitialLanguage(),
  fallbackLng: "es",
  interpolation: { escapeValue: false },
});

// Keep <html lang> aligned with the active UI language (a11y / spellcheck / hyphenation).
if (typeof document !== "undefined") {
  document.documentElement.lang = i18n.language;
  i18n.on("languageChanged", (lang) => {
    document.documentElement.lang = lang;
  });
}

export default i18n;

export { Trans, useTranslation } from "react-i18next";

function shownNameBaseText(name: ShownNameBase): string {
  switch (name.kind) {
    case "text":
      return name.text;
    case "pays_card":
      return i18n.t("expenses.creditCard.paymentName.paysCard", { brand: name.card_brand, last4: name.card_last4 });
    case "paid_by_card":
      return i18n.t("expenses.creditCard.paymentName.paidByCard", { brand: name.card_brand, last4: name.card_last4 });
    case "paid_from_account":
      return i18n.t("expenses.creditCard.paymentName.paidFromAccount", { account: name.account_name });
  }
}

/**
 * The words of the one name a row shows (the server's `name`): its text, a card payment's name
 * («Pago Lider ·0101»), or a refund under its purchase's name («Reembolso · …»). Read at render time.
 */
export function shownNameText(name: ShownName): string {
  if (name.kind === "refund_of") return i18n.t("expenses.creditCard.lineRow.refundOf", { name: shownNameBaseText(name.purchase) });
  return shownNameBaseText(name);
}

export function ccExpenseCategoryLabel(slug: string): string {
  const key = `expenses.creditCard.categories.${slug}`;
  const t = i18n.t(key);
  return t === key ? slug : t;
}

export function expenseKindLabel(kind: string | null | undefined): string {
  if (!kind) return "—";
  const key = `expenses.kinds.${kind}`;
  const t = i18n.t(key);
  return t === key ? kind : t;
}

export function depositFlowCategoryLabel(cat: DepositFlowCategory): string {
  const key: Record<DepositFlowCategory, string> = {
    real_estate: "dashboard.buckets.real_estate",
    cash: "dashboard.buckets.cash_eqs",
    brokerage: "dashboard.buckets.brokerage",
    inversiones: "sidebar.inversiones",
  };
  return i18n.t(key[cat]);
}

/** Flows → PL bucket labels: same keys as the dashboard buckets. */
export function flowsPlBucketLabel(slug: FlowsPlBucketSlug): string {
  const key: Record<FlowsPlBucketSlug, string> = {
    brokerage: "dashboard.buckets.brokerage",
    retirement: "dashboard.buckets.retirement",
    cash: "dashboard.buckets.cash_eqs",
    real_estate: "dashboard.buckets.real_estate",
  };
  return i18n.t(key[slug]);
}
