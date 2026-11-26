/** Request bodies of the grocery catalog write routes (`server/src/routes/groceries.ts`). */
import { z } from "zod";
import { requiredText, rowIdSchema } from "./fields.js";

/** A product's base unit: 'un' is the count dimension, the rest mass (g, kg), volume (ml, l) and length (m). */
export const GROCERY_BASE_UNITS = ["un", "g", "kg", "ml", "l", "m"] as const;
export type GroceryBaseUnit = (typeof GROCERY_BASE_UNITS)[number];
const groceryBaseUnitSchema = z.enum(GROCERY_BASE_UNITS);

/** `PATCH /api/groceries/products/:id`. */
export const groceryProductPatchSchema = z.object({
  base_unit: z.enum(GROCERY_BASE_UNITS, { error: "invalid product id or base_unit" }),
});
export type GroceryProductPatch = z.input<typeof groceryProductPatchSchema>;

/** `POST /api/groceries/products/:id/merge`: the product the source is merged into. */
export const groceryProductMergeSchema = z.object({
  into_product_id: z.number({ error: "invalid product ids" }).int("invalid product ids").positive("invalid product ids"),
});
export type GroceryProductMerge = z.input<typeof groceryProductMergeSchema>;

/** `PATCH /api/groceries/aliases/:id`: brand (an id, a name, or null to clear) and content (with its unit). */
export const groceryAliasPatchSchema = z
  .object({
    brand_id: rowIdSchema.nullish(),
    brand_name: z.string().optional(),
    content_value: z.number().nullish(),
    content_unit: groceryBaseUnitSchema.optional(),
  })
  .refine((b) => b.content_value == null || b.content_unit !== undefined, {
    message: "content_unit required with content_value",
    path: ["content_unit"],
  });
export type GroceryAliasPatch = z.input<typeof groceryAliasPatchSchema>;

/** `POST /api/groceries/brands`, `PATCH /api/groceries/brands/:id`. */
export const groceryBrandNameSchema = z.object({ name: requiredText("name required") });
export type GroceryBrandName = z.input<typeof groceryBrandNameSchema>;

/** `POST /api/groceries/classify`: printed names of one chain assigned to a product (an id, or a new one by name). */
export const groceryClassifySchema = z.object({
  store_chain: requiredText("store_chain and targets are required"),
  targets: z
    .array(z.object({ barcode: z.string().nullable(), description: z.string() }))
    .min(1, "store_chain and targets are required"),
  product_id: rowIdSchema.nullish(),
  new_product_name: z.string().nullish(),
});
export type GroceryClassify = z.input<typeof groceryClassifySchema>;
