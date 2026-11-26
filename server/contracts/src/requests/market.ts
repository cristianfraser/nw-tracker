/** Request bodies of the market-data write routes (`server/src/routes/market.ts`). */
import { z } from "zod";
import { requiredText } from "./fields.js";

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const BID_ASK_DAY = "date (YYYY-MM-DD) required";
const BID_ASK_RATES = "positive buy_clp_per_usd and sell_clp_per_usd required";
/** `POST /api/fx/bid-ask`: a day's buy and sell rate (pesos per dollar; buy ≥ sell). */
export const fxBidAskUpsertSchema = z
  .object({
    date: z.string({ error: BID_ASK_DAY }).regex(DAY_RE, BID_ASK_DAY),
    buy_clp_per_usd: z.number({ error: BID_ASK_RATES }).positive(BID_ASK_RATES),
    sell_clp_per_usd: z.number({ error: BID_ASK_RATES }).positive(BID_ASK_RATES),
  })
  .refine((b) => b.buy_clp_per_usd >= b.sell_clp_per_usd, { message: "buy_clp_per_usd must be >= sell_clp_per_usd" });
export type FxBidAskUpsert = z.input<typeof fxBidAskUpsertSchema>;

/** `POST /api/fx`: a day's dólar observado. */
export const fxUpsertSchema = z.object({
  date: z.string({ error: "date must be YYYY-MM-DD" }).regex(DAY_RE, "date must be YYYY-MM-DD"),
  clp_per_usd: z.number({ error: "positive clp_per_usd required" }).positive("positive clp_per_usd required"),
});
export type FxUpsert = z.input<typeof fxUpsertSchema>;

const SPLIT_ID = "ticker and ex_date (YYYY-MM-DD) required";
const SPLIT_RATIO = "numerator and denominator must be positive numbers";
/** `POST /api/equity-splits`: 3 and 1 for a 3-for-1 (whether it is a split is the server's check). */
export const equitySplitCreateSchema = z.object({
  ticker: requiredText(SPLIT_ID),
  ex_date: z.string({ error: SPLIT_ID }).regex(DAY_RE, SPLIT_ID),
  numerator: z.number({ error: SPLIT_RATIO }).positive(SPLIT_RATIO),
  denominator: z.number({ error: SPLIT_RATIO }).positive(SPLIT_RATIO),
});
export type EquitySplitCreate = z.input<typeof equitySplitCreateSchema>;

/** `PATCH /api/watchlist/:id`: null leaves a field as it is. */
export const watchlistRowPatchSchema = z.object({
  show_in_marquee: z.union([z.literal(0), z.literal(1)], { error: "show_in_marquee must be 0 or 1" }).nullish(),
  sort_order: z.number({ error: "sort_order must be a finite number" }).nullish(),
});
export type WatchlistRowPatch = z.input<typeof watchlistRowPatchSchema>;

/** `POST /api/watchlist`: a symbol to add (its shape and listing checked by the server). */
export const watchlistAddSchema = z.object({ ticker: z.string({ error: "ticker required" }).refine((t) => t.trim() !== "", { message: "ticker required" }) });
export type WatchlistAdd = z.input<typeof watchlistAddSchema>;
