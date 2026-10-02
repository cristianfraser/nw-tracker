import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  classifyCcStatementLine,
  isCcTraspasoDeudaMerchant,
  type CcStatementLineSection,
} from "./ccStatementSection3.js";

type SectionCase = {
  currency: "clp" | "usd";
  layout: string;
  merchant: string;
  amount: number;
  section: CcStatementLineSection;
  traspaso_deuda?: boolean;
  note?: string;
};

const casesPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "test",
  "ccStatementLineSectionCases.json"
);
const cases = JSON.parse(fs.readFileSync(casesPath, "utf-8")) as SectionCase[];

/** The same table is asserted by `ingest/python/cc_statement_line_rules_test.py`. */
describe("classifyCcStatementLine (shared case table)", () => {
  it.each(cases)("$currency $layout «$merchant» $amount → $section", (c) => {
    expect(
      classifyCcStatementLine({
        currency: c.currency,
        merchant: c.merchant,
        parser_layout: c.layout,
        amount: c.amount,
      })
    ).toBe(c.section);
    expect(isCcTraspasoDeudaMerchant(c.merchant)).toBe(c.traspaso_deuda === true);
  });
});
