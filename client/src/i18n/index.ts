import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import type { BrokeragePortfolioGroup } from "../brokerageGroupedAggregation";
import es from "./locales/es.json";

void i18n.use(initReactI18next).init({
  resources: {
    es: { translation: es },
  },
  lng: "es",
  fallbackLng: "es",
  interpolation: { escapeValue: false },
});

export default i18n;

export { Trans, useTranslation } from "react-i18next";

/** User-visible label for a brokerage portfolio subgroup (sidebar, cards, charts). */
export function brokerageGroupLabel(group: BrokeragePortfolioGroup): string {
  return i18n.t(`brokerage.groups.${group}`);
}

export function dashboardBucketLabel(bucket: "real_estate" | "retirement" | "brokerage" | "cash_eqs"): string {
  return i18n.t(`dashboard.buckets.${bucket}`);
}
