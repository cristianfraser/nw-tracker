import { fileURLToPath } from "node:url";

/**
 * Where a card statement line belongs (operaciones, cargos y abonos, a mid-period payment…): one
 * rule set, `data/ccStatementLineRules.json`, read by the server's import reconcile
 * (`server/src/ccStatementLineRules.ts`) and by the PDF parser's own (`ingest/python/
 * cc_statement_line_rules.py`), so both sum a statement the same way. The server's gates are the
 * authority; the parser conforms. Both test suites assert `server/src/test/ccStatementLineSectionCases.json`.
 */
export const CC_STATEMENT_LINE_RULES_PATH = fileURLToPath(new URL("../data/ccStatementLineRules.json", import.meta.url));
