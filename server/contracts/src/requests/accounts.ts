/** Request bodies of the account write routes (`server/src/routes/accounts.ts`). */
import { z } from "zod";
import { requiredText, rowIdSchema } from "./fields.js";

export const PANEL_ACCOUNT_TYPES = ["equity", "crypto", "clp_cash", "usd_cash", "foreign_cash", "option"] as const;

/** An option contract's terms (the server derives the OCC symbol and the name, and checks the underlying). */
export const panelOptionContractInputSchema = z.object({
  underlying: z.string(),
  right: z.enum(["C", "P"], { error: "account.option.right must be C or P" }),
  strike: z.number().positive({ error: "account.option.strike must be a positive number" }),
  /** YYYY-MM-DD */
  expiry: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "account.option.expiry must be YYYY-MM-DD"),
  /** Shares per contract; 100 when absent. */
  multiplier: z.number().int().positive({ error: "account.option.multiplier must be a positive whole number" }).optional(),
});

/**
 * `POST /api/accounts` from the panel: the account's type, its bucket and what it holds. Which
 * fields a type needs (a ticker, an option's terms, a currency) and the bucket's rules are the
 * server's, checked against the tree and the instrument registry.
 */
export const panelAccountCreateSchema = z.object({
  account: z.object({
    account_type: z.enum(PANEL_ACCOUNT_TYPES, { error: `account.account_type must be one of ${PANEL_ACCOUNT_TYPES.join(", ")}` }),
    /** The display name; an option contract may leave it empty and takes «SPY 2025-06-20 C 600». */
    name: z.string().optional(),
    /** Leaf bucket slug from the nav tree; an option contract always sits under `brokerage_opciones`. */
    bucket_slug: z.string().optional(),
    category_slug: z.string().optional(),
    ticker: z.string().optional(),
    option: panelOptionContractInputSchema.optional(),
    /** A foreign cash account's currency (a code of `currencies` other than pesos). */
    currency: z.string().optional(),
    exclude_from_group_totals: z.boolean().default(false),
  }),
});
export type PanelAccountCreateRequest = z.input<typeof panelAccountCreateSchema>;
export type PanelAccountCreate = z.output<typeof panelAccountCreateSchema>;

/** `POST /api/accounts` without `account`: a bare account in an asset group. */
export const bareAccountCreateSchema = z.object({
  asset_group_id: rowIdSchema,
  name: requiredText("name required"),
  notes: z.string().nullish(),
});
export type BareAccountCreate = z.input<typeof bareAccountCreateSchema>;

/** `PATCH /api/accounts/:id`: rename and/or move (at least one; the server checks both). */
export const panelAccountUpdateSchema = z.object({
  name: z.string({ error: "name must be a non-empty string" }).optional(),
  bucket_slug: z.string().optional(),
});
export type PanelAccountUpdate = z.input<typeof panelAccountUpdateSchema>;

/** `PATCH …/color` (accounts, portfolio groups, liability groups): a color, or null for the default. */
export const colorPatchSchema = z.object({
  color_rgb: z.string({ error: "invalid color_rgb" }).nullable(),
});
export type ColorPatch = z.input<typeof colorPatchSchema>;

/** `PATCH /api/accounts/:id/exclude-from-group-totals`. */
export const excludeFromGroupTotalsPatchSchema = z.object({
  exclude_from_group_totals: z.boolean({ error: "exclude_from_group_totals must be boolean" }),
});
export type ExcludeFromGroupTotalsPatch = z.input<typeof excludeFromGroupTotalsPatchSchema>;

/** `PATCH /api/portfolio-groups/:slug/basket`. */
export const portfolioGroupBasketPatchSchema = z.object({ basket: z.boolean({ error: "basket must be boolean" }) });
export type PortfolioGroupBasketPatch = z.input<typeof portfolioGroupBasketPatchSchema>;

/** `PUT /api/accounts/:id/checking-ledger-anchor`: clear it, or set it (pesos, rounded) on a day. */
const ANCHOR_AMOUNT_REQUIRED = "amount_clp required (number, 0 allowed)";
const ANCHOR_DAY_REQUIRED = "occurred_on required (YYYY-MM-DD)";
export const checkingLedgerAnchorPutSchema = z
  .object({
    clear: z.boolean().optional(),
    amount_clp: z.number({ error: ANCHOR_AMOUNT_REQUIRED }).optional(),
    occurred_on: z.string({ error: ANCHOR_DAY_REQUIRED }).regex(/^\d{4}-\d{2}-\d{2}$/, ANCHOR_DAY_REQUIRED).optional(),
  })
  .superRefine((b, ctx) => {
    if (b.clear === true) return;
    if (b.amount_clp === undefined) ctx.addIssue({ code: "custom", path: ["amount_clp"], message: ANCHOR_AMOUNT_REQUIRED });
    else if (b.occurred_on === undefined) ctx.addIssue({ code: "custom", path: ["occurred_on"], message: ANCHOR_DAY_REQUIRED });
  });
export type CheckingLedgerAnchorPut = z.input<typeof checkingLedgerAnchorPutSchema>;
