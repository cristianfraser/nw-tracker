/** Request bodies of the flows write routes (`server/src/routes/flows.ts`). */
import { z } from "zod";
import { currencyCodeSchema, isoDateSchema } from "../formats/schemas.js";
import { requiredText, rowIdSchema, trimmedText } from "./fields.js";

/** The kinds a checking credit can be classified as on the income page. */
export const CHECKING_INCOME_KINDS = [
  "salary",
  "severance",
  "other",
  "parent_gift",
  /** Rent of a tracked place (`expense_accounts`): the override names the place (`rent_place_id`). */
  "rent",
] as const;

/** `PATCH /api/work-earnings/:id`: a null earning type changes nothing; a null movement unlinks. */
export const workEarningPatchSchema = z.object({
  earning_type: z.enum(["salary", "severance"], { error: "earning_type must be salary or severance" }).nullish(),
  movement_id: rowIdSchema.nullish(),
});
export type WorkEarningPatch = z.input<typeof workEarningPatchSchema>;

/** `PATCH /api/income/movements/:movement_id`: a null kind clears it. */
export const incomeMovementPatchSchema = z
  .object({
    income_kind: z
      .enum(CHECKING_INCOME_KINDS, { error: `income_kind must be one of ${CHECKING_INCOME_KINDS.join(", ")}` })
      .nullish(),
    rent_place_slug: z.string({ error: "rent_place_slug must be a place slug" }).optional(),
    excluded: z.boolean().optional(),
    force_include: z.boolean().optional(),
    note: z.string().nullish(),
  })
  .refine(
    (b) => b.income_kind !== undefined || b.excluded !== undefined || b.force_include !== undefined || b.note !== undefined,
    { message: "income_kind, excluded, force_include, or note required" }
  );
export type IncomeMovementPatch = z.input<typeof incomeMovementPatchSchema>;

/** `POST /api/income/movements/:movement_id/refund`: a blank category is none. */
export const incomeRefundRequestSchema = z.object({ category_slug: trimmedText.optional() });
export type IncomeRefundRequest = z.input<typeof incomeRefundRequestSchema>;

export const expenseLinePieceSourceSchema = z.enum(["cc", "checking"], { error: "source must be cc or checking" });

/** One piece of `PUT /api/flows/expenses/line-pieces` (amount and category checked against the line). */
export const expenseLinePieceInputSchema = z.object({
  /** An existing piece's seq to keep its big group and note; absent for a new piece. */
  seq: z.number().int().nullish(),
  spent_on: isoDateSchema.nullish(),
  amount: z.number(),
  category_slug: z.string(),
});
export type ExpenseLinePieceInputBody = z.input<typeof expenseLinePieceInputSchema>;

export const expenseLinePiecesPutSchema = z.object({
  source: expenseLinePieceSourceSchema,
  line_id: rowIdSchema,
  pieces: z.array(expenseLinePieceInputSchema, { error: "pieces must be an array" }),
});
export type ExpenseLinePiecesPut = z.input<typeof expenseLinePiecesPutSchema>;

/** `POST /api/flows/expenses/manual`, `PATCH …/manual/:id` (amount, currency and category checked by the server). */
export const manualExpenseInputSchema = z.object({
  spent_on: isoDateSchema,
  amount: z.number(),
  currency: currencyCodeSchema,
  category_slug: z.string(),
  description: requiredText("description required"),
});
export type ManualExpenseRequest = z.input<typeof manualExpenseInputSchema>;

/** `POST /api/flows/expenses/financing-links`: the facturado and the cuota purchases that financed it. */
export const financingLinkUpsertSchema = z.object({
  financed_account_id: rowIdSchema,
  financed_billing_month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/, "financed_billing_month must be YYYY-MM"),
  financing: z
    .array(z.object({ account_id: rowIdSchema, purchase_key: requiredText("purchase_key required") }))
    .default([]),
});
export type FinancingLinkUpsert = z.input<typeof financingLinkUpsertSchema>;

/** `PUT /api/flows/expenses/real-estate/links`. */
export const realEstateLinkPutSchema = z.object({
  expense_entry_id: rowIdSchema,
  purchase_key: requiredText("purchase_key required"),
});
export type RealEstateLinkPut = z.input<typeof realEstateLinkPutSchema>;

/** `POST /api/flows/expenses/real-estate/places` (slug, label and dates checked by the server). */
export const realEstatePlaceCreateSchema = z.object({
  slug: z.string(),
  label: z.string(),
  active_from: z.string().nullish(),
  active_to: z.string().nullish(),
  property_account_id: rowIdSchema.nullish(),
  dfl2: z.boolean().optional(),
  dfl2_built_m2: z.number().nullish(),
  dfl2_reception_year: z.number().nullish(),
});
export type RealEstatePlaceCreate = z.input<typeof realEstatePlaceCreateSchema>;

/** `PATCH /api/flows/expenses/real-estate/places/:slug/dfl2`. */
export const realEstatePlaceDfl2PatchSchema = z.object({
  dfl2: z.boolean({ error: "dfl2 must be a boolean" }),
  dfl2_built_m2: z.number({ error: "dfl2_built_m2 must be a number" }).nullish(),
  dfl2_reception_year: z.number({ error: "dfl2_reception_year must be a number" }).nullish(),
});
export type RealEstatePlaceDfl2Patch = z.input<typeof realEstatePlaceDfl2PatchSchema>;

/** `POST /api/flows/expenses/real-estate/assign`. */
export const realEstateAssignSchema = z.object({
  purchase_key: requiredText("purchase_key required"),
  account_slug: requiredText("account_slug required"),
  kind: requiredText("kind required"),
  bill_month: z.string().optional(),
  kwh: z.number().nullish(),
  m3: z.number().nullish(),
});
export type RealEstateAssign = z.input<typeof realEstateAssignSchema>;

/** `PATCH /api/flows/expenses/real-estate/entries/:id/bill-month`. */
export const realEstateBillMonthPatchSchema = z.object({
  bill_month: z.string({ error: "bill_month must be YYYY-MM" }).trim().regex(/^\d{4}-\d{2}$/, "bill_month must be YYYY-MM"),
});
export type RealEstateBillMonthPatch = z.input<typeof realEstateBillMonthPatchSchema>;

/** `PATCH /api/flows/expenses/real-estate/entries/:id/months-covered` (the range checked by the server). */
export const realEstateMonthsCoveredPatchSchema = z.object({ months_covered: z.number() });
export type RealEstateMonthsCoveredPatch = z.input<typeof realEstateMonthsCoveredPatchSchema>;

/** `PATCH /api/flows/expenses/real-estate/entries/:id/consumption`. */
export const realEstateConsumptionPatchSchema = z.object({ kwh: z.number().nullish(), m3: z.number().nullish() });
export type RealEstateConsumptionPatch = z.input<typeof realEstateConsumptionPatchSchema>;

/** `PATCH /api/flows/expenses/purchase-notes`: the purchase by its key or by one of its statement lines. */
export const purchaseNotePatchSchema = z
  .object({
    account_id: rowIdSchema,
    purchase_key: trimmedText.optional(),
    statement_line_id: rowIdSchema.optional(),
    notes: z.string().nullish(),
  })
  .refine((b) => Boolean(b.purchase_key) || b.statement_line_id != null, {
    message: "purchase_key or statement_line_id required",
  });
export type PurchaseNotePatch = z.input<typeof purchaseNotePatchSchema>;

/** `POST /api/flows/expenses/vendor-branch-choice`. */
export const vendorBranchChoiceSchema = z.object({
  key: requiredText("key required"),
  display: requiredText("display required"),
});
export type VendorBranchChoice = z.input<typeof vendorBranchChoiceSchema>;

/** `PUT /api/flows/expenses/purchase-big-group`: a null group clears it. */
export const purchaseBigGroupPutSchema = z.object({
  purchase_key: requiredText("purchase_key required"),
  group_slug: z.string().nullish(),
});
export type PurchaseBigGroupPut = z.input<typeof purchaseBigGroupPutSchema>;

/** `POST /api/flows/expenses/big-groups`, `PATCH …/big-groups/:slug`. */
export const bigGroupLabelSchema = z.object({ label: requiredText("label required") });
export type BigGroupLabel = z.input<typeof bigGroupLabelSchema>;

/** `PUT /api/flows/expenses/refund-links`: a card credit and the purchase line it refunds. */
export const refundLinkPutSchema = z.object({
  account_id: rowIdSchema,
  line_id: rowIdSchema,
  purchase_line_id: z
    .number()
    .int()
    .refine((n) => n !== 0, { message: "purchase_line_id must be a non-zero integer" }),
});
export type RefundLinkPut = z.input<typeof refundLinkPutSchema>;

export const CATEGORY_RULE_LINK_KINDS = ["receipt", "app", "recipient"] as const;

/** `PATCH /api/flows/expenses/lines/:lineId/category`. */
export const expenseLineCategoryPatchSchema = z.object({
  category_slug: trimmedText.optional(),
  unique: z.boolean().optional(),
  clear_category: z.boolean().optional(),
  source: z.enum(["cc", "checking", "manual", "payslip"]).optional(),
  /** «Específico»: the line's link (`category_link`), so the change writes the specific rule. */
  rule_link: z.object({ kind: z.enum(CATEGORY_RULE_LINK_KINDS), key: z.string() }).nullish(),
});
export type ExpenseLineCategoryPatch = z.input<typeof expenseLineCategoryPatchSchema>;
