import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CARD_PARSED_STATEMENT_COLUMNS } from "../kinds/cardParsedStatements.js";
import { ccCardRegistrySchema } from "./ccCards.js";
import { ccStatementLineRulesSchema } from "./ccStatementLineRules.js";
import {
  parsedCartolaPdfFileSchema,
  parsedGroceryReceiptSchema,
  parsedPayrollIndexSchema,
} from "./parserOutputs.js";

export * from "./ccCards.js";
export * from "./ccStatementLineRules.js";
export * from "./parserOutputs.js";

/**
 * Files read in more than one language (docs/untangle-plan.md F8), each with a JSON Schema in
 * `data/schemas/<name>.schema.json` (written by `npm run schema -w nw-tracker-contracts -- --shared`,
 * held equal to these by `schemas.test.ts`). The TypeScript side parses with the zod schema, Python
 * validates against the JSON file (`ingest/python/shared_schema.py`).
 */
export const SHARED_FILE_SCHEMAS = {
  "cc-cards": ccCardRegistrySchema,
  "cc-statement-line-rules": ccStatementLineRulesSchema,
  "parsed-payroll-index": parsedPayrollIndexSchema,
  "parsed-cartola-pdf-file": parsedCartolaPdfFileSchema,
  "parsed-grocery-receipt": parsedGroceryReceiptSchema,
} as const;

export type SharedFileSchemaName = keyof typeof SHARED_FILE_SCHEMAS;

export const SHARED_SCHEMA_DIR = fileURLToPath(new URL("../../data/schemas/", import.meta.url));

/** Each shared file's JSON Schema (input side: a key with a default may be left out). */
export function sharedFileJsonSchemas(): Record<SharedFileSchemaName, unknown> {
  const out = {} as Record<SharedFileSchemaName, unknown>;
  for (const [name, schema] of Object.entries(SHARED_FILE_SCHEMAS) as [SharedFileSchemaName, z.ZodType][]) {
    out[name] = z.toJSONSchema(schema, { io: "input" });
  }
  return out;
}

/**
 * The card statement parser's CSV columns as data (`data/schemas/card-parsed-statement-columns.json`),
 * which the parser's `CSV_COLUMNS` must equal (`shared_schema_test.py`).
 */
export function cardParsedStatementColumnsJson(): { columns: readonly string[] } {
  return { columns: CARD_PARSED_STATEMENT_COLUMNS };
}

/** Every file `--shared` writes under `data/schemas/`, by file name. */
export function sharedSchemaFiles(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(sharedFileJsonSchemas())) {
    files[`${name}.schema.json`] = `${JSON.stringify(schema, null, 2)}\n`;
  }
  files["card-parsed-statement-columns.json"] = `${JSON.stringify(cardParsedStatementColumnsJson(), null, 2)}\n`;
  return files;
}
