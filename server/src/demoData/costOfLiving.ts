/**
 * What living in a city costs, per category, for the demo person's lifestyle model.
 *
 * Each city states the monthly baseline of a single, mid-high-income person (no dependants, rent
 * apart) per category, in the city's own currency at `referenceMonth`. The figures are
 * Numbeo-style: hand-tuned from the general shape of published cost-of-living comparisons and to
 * keep the story's history, never scraped, fetched or taken from anyone's records (no network, no
 * personal data). They are the story's assumptions, not statistics.
 *
 * The person's lifestyle is one dimensionless multiplier (m, the ratchet in `simulate.ts`, concave
 * in his smoothed income): in the city he lives in that month a category's budget is
 * m × baseline × the season × the city's price index since `referenceMonth`, so the category
 * shares fall out of the baselines. How a row is paid:
 * - `drawn`: purchases drawn from the city's merchant pool (`pool`) for that budget.
 * - `bills`: the city's recurring household bills (`bills`, each a share of the row), each priced
 *   m × baseline × share × season × index.
 * - `list`: fixed-price commitments he picks (subscriptions, the gym), at their list prices (the
 *   gym's rises with the index); the multiplier does not apply (a richer person does not pay 1,2
 *   Netflixes). The baseline states their sum at the reference.
 * - `housing`: paid by the housing model (a lease's or an owner's bills), not by the lifestyle; the
 *   baseline is the level, for reference only.
 *
 * Price index: Santiago reads the real IPC the simulator already uses (its budgets are real pesos
 * made nominal through the UF), Austin a yearly US CPI-ish rate (`yearlyInflation`: the demo has
 * no US CPI series).
 */

export type CityKey = "santiago" | "austin";

/** The cost categories a city states (the app's expense category is the row's `slug`). */
export type LifestyleCategory =
  | "groceries"
  | "restaurants"
  | "delivery"
  | "transport"
  | "utilities"
  | "subscriptions"
  | "fun"
  | "hobbies"
  | "clothing"
  | "personalCare"
  | "healthcare"
  | "others";

export type CostRow = {
  /** The app's expense category the row's spending is filed under. */
  slug: string;
  /** Monthly, in the city's currency at `referenceMonth`, for multiplier 1. */
  baseline: number;
  paidAs: "drawn" | "bills" | "list" | "housing";
  /** `drawn`: the simulator's merchant pool for the row. */
  pool?: string;
  /** `drawn`: on the credit card once he has one, or always by debit (groceries in Austin). */
  pay?: "card" | "debit";
  /** `bills`: each bill's description, its share of the row (the shares add up to 1) and its day. */
  bills?: readonly { desc: string; share: number; day: number }[];
};

export type CityCostOfLiving = {
  city: CityKey;
  currency: "clp" | "usd";
  /** The month the baselines are priced at; null = the person's `realBaseMonth` (Santiago's real pesos). */
  referenceMonth: string | null;
  /** The yearly price rise (Austin); null where the IPC is read (Santiago). */
  yearlyInflation: number | null;
  /** In draw order: the simulator draws the rows in this order, so reordering moves every later draw. */
  rows: Partial<Record<LifestyleCategory, CostRow>>;
};

/**
 * Santiago, real pesos of the person's `realBaseMonth` (2016-01 for the demo). The drawn rows keep the shares the story has
 * always used (0,27 / 0,19 / 0,13 / 0,07 / 0,08 / 0,11 / 0,06 / 0,06 / 0,03 of 525.000), so the
 * Chilean years draw exactly what they drew: delivery rides in the restaurants pool (Rappi,
 * PedidosYa, Uber Eats beside the restaurants) and personal care in others (the barber), so neither
 * has a row of its own; utilities are the housing model's (a tenant's or an owner's bills).
 */
export const SANTIAGO: CityCostOfLiving = {
  city: "santiago",
  currency: "clp",
  referenceMonth: null,
  yearlyInflation: null,
  rows: {
    groceries: { slug: "supermarket", baseline: 141_750, paidAs: "drawn", pool: "supermarket" },
    restaurants: { slug: "food", baseline: 99_750, paidAs: "drawn", pool: "food" },
    fun: { slug: "fun", baseline: 68_250, paidAs: "drawn", pool: "fun" },
    transport: { slug: "transportation", baseline: 36_750, paidAs: "drawn", pool: "transportation" },
    clothing: { slug: "clothes", baseline: 42_000, paidAs: "drawn", pool: "clothes" },
    others: { slug: "others", baseline: 57_750, paidAs: "drawn", pool: "others" },
    hobbies: { slug: "hobbies", baseline: 31_500, paidAs: "drawn", pool: "hobbies" },
    healthcare: { slug: "healthcare", baseline: 31_500, paidAs: "drawn", pool: "healthcare" },
    subscriptions: { slug: "subscriptions", baseline: 15_750, paidAs: "drawn", pool: "subscriptions" },
    utilities: { slug: "bills", baseline: 95_000, paidAs: "housing" },
  },
};

/**
 * Austin, Texas, dollars of 2024-04 (the move), tuned so the US months spend about what the
 * story spent before the table existed (m is ≈ 1,04 at the move and rises with the US pay, ≈ 1,24 by late 2026). Groceries stay on the debit card; every other
 * drawn row goes on the credit card once it opens. Transport is fuel and tolls once he has a car,
 * rideshare and the bus before it (the `transport_carless` pool, at 60 % of the row).
 */
export const AUSTIN: CityCostOfLiving = {
  city: "austin",
  currency: "usd",
  referenceMonth: "2024-04",
  yearlyInflation: 0.03,
  rows: {
    groceries: { slug: "supermarket", baseline: 420, paidAs: "drawn", pool: "groceries", pay: "debit" },
    restaurants: { slug: "food", baseline: 235, paidAs: "drawn", pool: "restaurants", pay: "card" },
    delivery: { slug: "food", baseline: 70, paidAs: "drawn", pool: "delivery", pay: "card" },
    transport: { slug: "transportation", baseline: 165, paidAs: "drawn", pool: "transport", pay: "card" },
    fun: { slug: "fun", baseline: 105, paidAs: "drawn", pool: "fun", pay: "card" },
    clothing: { slug: "clothes", baseline: 85, paidAs: "drawn", pool: "clothing", pay: "card" },
    personalCare: { slug: "others", baseline: 40, paidAs: "drawn", pool: "personalCare", pay: "card" },
    healthcare: { slug: "healthcare", baseline: 55, paidAs: "drawn", pool: "healthcare", pay: "card" },
    others: { slug: "others", baseline: 135, paidAs: "drawn", pool: "others", pay: "card" },
    utilities: {
      slug: "bills",
      baseline: 240,
      paidAs: "bills",
      bills: [
        { desc: "AUSTIN ENERGY UTILITY", share: 88 / 251, day: 12 },
        { desc: "TEXAS GAS SERVICE", share: 28 / 251, day: 14 },
        { desc: "GOOGLE FIBER", share: 70 / 251, day: 16 },
        { desc: "T-MOBILE AUTOPAY", share: 65 / 251, day: 18 },
      ],
    },
    // Spotify, iCloud, ChatGPT, GitHub, Notion from the move; Netflix, the NYT, Hulu with the card.
    subscriptions: { slug: "subscriptions", baseline: 89.45, paidAs: "list" },
    hobbies: { slug: "hobbies", baseline: 89, paidAs: "list" },
  },
};

export const CITIES: Record<CityKey, CityCostOfLiving> = { santiago: SANTIAGO, austin: AUSTIN };

/** Σ of a city's drawn baselines: the basket two cities are compared by. */
export function drawnBasketTotal(city: CityCostOfLiving): number {
  return Object.values(city.rows).reduce((a, r) => a + (r && r.paidAs === "drawn" ? r.baseline : 0), 0);
}

/**
 * Santiago basket units per unit of the city's currency (1 for Santiago): how a dollar earned in
 * Austin compares with a real peso earned in Santiago for the lifestyle ratchet.
 */
export function santiagoBasketPerUnit(city: CityCostOfLiving): number {
  return drawnBasketTotal(SANTIAGO) / drawnBasketTotal(city);
}

/**
 * A city's drawn rows in their order, each with `perLevel` = its baseline ÷ Santiago's basket
 * total: the lifestyle level (m × Santiago's basket) × `perLevel` is the row's budget (m × baseline),
 * which for Santiago is the level × the row's share, bit for bit what the story always drew.
 */
export function drawnRows(city: CityCostOfLiving): { key: LifestyleCategory; row: CostRow; perLevel: number }[] {
  const total = drawnBasketTotal(SANTIAGO);
  return (Object.entries(city.rows) as [LifestyleCategory, CostRow][])
    .filter(([, r]) => r.paidAs === "drawn")
    .map(([key, row]) => ({ key, row, perLevel: row.baseline / total }));
}
