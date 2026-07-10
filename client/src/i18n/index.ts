import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { BrokeragePortfolioGroup } from "../brokerageGroupedAggregation";
import { readInitialLanguage } from "../languagePreference";
import type { DepositFlowCategory, ExpenseApartmentSlug } from "../types";
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

/** User-visible label for a brokerage portfolio subgroup (sidebar, cards, charts). */
export function brokerageGroupLabel(group: BrokeragePortfolioGroup): string {
  return i18n.t(`brokerage.groups.${group}`);
}

export function dashboardBucketLabel(bucket: "real_estate" | "retirement" | "brokerage" | "cash_eqs"): string {
  if (bucket === "cash_eqs") return i18n.t("dashboard.buckets.cash_savings");
  return i18n.t(`dashboard.buckets.${bucket}`);
}

/** Deposit-flow categories: same Spanish labels as dashboard buckets (retirement deposits → Retiro). */
export function expenseApartmentLabel(slug: ExpenseApartmentSlug): string {
  return i18n.t(`expenses.accounts.${slug}`);
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
