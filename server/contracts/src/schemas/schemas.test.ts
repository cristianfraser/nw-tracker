import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CC_STATEMENT_LINE_RULES_PATH } from "../ccStatementLineRules.js";
import { SHARED_SCHEMA_DIR, ccCardRegistrySchema, ccStatementLineRulesSchema, sharedSchemaFiles } from "./index.js";

describe("shared file schemas", () => {
  it("are committed as generated (`npm run schema -w nw-tracker-contracts -- --shared`)", () => {
    const files = sharedSchemaFiles();
    for (const [file, text] of Object.entries(files)) {
      expect(fs.readFileSync(path.join(SHARED_SCHEMA_DIR, file), "utf8"), file).toBe(text);
    }
    const committed = fs.readdirSync(SHARED_SCHEMA_DIR).sort();
    expect(committed).toEqual(Object.keys(files).sort());
  });

  it("accept the committed line rules", () => {
    ccStatementLineRulesSchema.parse(JSON.parse(fs.readFileSync(CC_STATEMENT_LINE_RULES_PATH, "utf8")));
  });

  it("fill a card registry's missing keys and refuse an unknown one", () => {
    expect(ccCardRegistrySchema.parse({ lider_filename_last4s: ["0001"] })).toMatchObject({
      import_redirect_last4: {},
      lider_filename_last4s: ["0001"],
      boleta_sucursal_merchants: {},
    });
    expect(() => ccCardRegistrySchema.parse({ unknown_key: [] })).toThrow();
  });
});
