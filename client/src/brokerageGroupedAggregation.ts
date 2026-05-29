import { brokerageGroupLabel } from "./i18n";

export type BrokeragePortfolioGroup = "mutual_funds" | "acciones" | "cripto";

/** Display / navigation order on the Brokerage page. */
export const BROKERAGE_GROUP_ORDER: readonly BrokeragePortfolioGroup[] = [
  "mutual_funds",
  "acciones",
  "cripto",
];

export function brokeragePortfolioGroupLabel(g: BrokeragePortfolioGroup): string {
  return brokerageGroupLabel(g);
}

/** React Router path for a brokerage leaf bucket (matches nav `route_path`). */
export function brokeragePortfolioGroupPath(g: BrokeragePortfolioGroup): string {
  if (g === "mutual_funds") return "/inversiones/brokerage/mutual-funds";
  if (g === "acciones") return "/inversiones/brokerage/acciones";
  return "/inversiones/brokerage/crypto";
}

export function brokeragePortfolioGroupFromBucketSlug(bucketSlug: string): BrokeragePortfolioGroup | null {
  if (bucketSlug === "brokerage_mutual_funds") return "mutual_funds";
  if (bucketSlug === "brokerage_acciones") return "acciones";
  if (bucketSlug === "brokerage_crypto") return "cripto";
  return null;
}

/** Fallback when `bucket_slug` is missing on list rows. */
export function brokeragePortfolioGroupFromCategorySlug(categorySlug: string): BrokeragePortfolioGroup | null {
  if (categorySlug === "individual_stocks") return null;
  if (categorySlug === "fintual_risky_norris") return "mutual_funds";
  if (categorySlug === "bitcoin" || categorySlug === "eth") return "cripto";
  return "acciones";
}
