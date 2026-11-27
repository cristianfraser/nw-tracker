import { describe, expect, it } from "vitest";
import type { BankAccountStatement, BankAccountStatementsPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { applyBankAccountStatements } from "./bankAccountStatementsApply.js";
import { checkingAccountId, rebuildCheckingLedgerFromCartolas } from "./checkingCartolaImport.js";
import { parsedCartolaFromStatement } from "./bankAccountStatementsApply.js";
import { snapshotExpenseIdentity } from "./checkingRestatementIdentity.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import { putFlowCategory } from "./flows/flowCategories.js";
import { checkingGastosMovementPurchaseKey } from "./flowsCheckingGastos.js";
import { rolledBack } from "./ingestReceiver.js";
import { clearAggregationCache } from "./cacheRegistry.js";
import { agreeingCartolaBalances } from "./test/cartolaFixtureBalances.js";

/**
 * A cartola month imported again in place whose rows print in other text (an older reader's
 * reading, re-read in the shared one): a category a rule gave a row stays (its own when the new
 * text no longer reaches the rule), a name the catalog gave it stays (the new spelling added to the
 * catalog), a category the user set is untouched, and anything the carry cannot keep refuses the
 * month. Synthetic vendors and rules, written and rolled back inside each case.
 */
const MONTH = "1806-03";
const TAG = "VITEST CARRY";

const mv = (date: string, amount: number, description: string) => ({ date, branch: "Centro", description, document_no: "", amount });

function statement(movements: ReturnType<typeof mv>[]): BankAccountStatement {
  const period = { period_month: MONTH, period_from: `${MONTH}-01`, period_to: `${MONTH}-31` };
  const { opening, closing } = agreeingCartolaBalances(checkingAccountId(), period, movements.map((m) => m.amount));
  return { document: `vitest-carry-${MONTH}.pdf`, ...period, opening_balance: opening, closing_balance: closing, month_closing_balances: null, movements, skipped_rows: [], notes: [] };
}

const payload = (st: BankAccountStatement, force = false): BankAccountStatementsPayload => ({
  account: { issuer: "santander", product: "checking" },
  force_reimport: force,
  statements: [st],
  unreadable: [],
});

const inRollback = (fn: () => void) => () => {
  try {
    rolledBack(fn);
  } finally {
    clearAggregationCache();
  }
};

const categoryId = (slug: string) => getCcExpenseCategoryBySlug(slug)!.id;
const rule = (vendor: string, slug: string) =>
  db.prepare(`INSERT INTO expense_category_rules (vendor, link_kind, link_key, category_id) VALUES (?, '', '', ?)`).run(vendor, categoryId(slug));
const catalogEntry = (pattern: string, display: string) =>
  db.prepare(`INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('exact', ?, ?, 'user')`).run(pattern, display);

/** The month's rows as the pages show them now, by their description. */
function shown() {
  clearAggregationCache();
  const s = snapshotExpenseIdentity(checkingAccountId(), [MONTH]);
  return new Map([...s.rows.values()].map((r) => [r.description, { id: r.movement_id, categories: [...r.lines.values()].map((l) => `${l.slug} (${l.source})`), name: r.name }]));
}

function importAgain(movements: ReturnType<typeof mv>[]) {
  clearAggregationCache();
  const details = applyBankAccountStatements(payload(statement(movements), true));
  return details;
}

describe("a cartola month imported again in other text", () => {
  it("keeps a rule's category as the row's own when the new text no longer reaches the rule, and reports it", inRollback(() => {
    rule(`${TAG} KIOSKO`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSKO`)])));
    const before = shown().get(`${TAG} KIOSKO`)!;
    expect(before.categories).toEqual(["food (rule)"]);
    const details = importAgain([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSCO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    const after = shown().get(`${TAG} KIOSCO`)!;
    expect(after.id).toBe(before.id);
    expect(after.categories).toEqual(["food (own)"]);
    expect(details.report.join("\n")).toMatch(/keeps its category as its own: movement \d+ → food/);
  }));

  it("carries the same way on the ledger rebuild (the repair of a month imported twice)", inRollback(() => {
    rule(`CENTRO ${TAG} PANADERIA`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-14`, -2_500, `Centro ${TAG} PANADERIA`)])));
    const before = shown().get(`Centro ${TAG} PANADERIA`)!;
    expect(before.categories).toEqual(["food (rule)"]);
    clearAggregationCache();
    const r = rebuildCheckingLedgerFromCartolas(checkingAccountId(), [parsedCartolaFromStatement(statement([mv(`${MONTH}-14`, -2_500, `${TAG} PANADERIA SUR`)]))]);
    const after = shown().get(`${TAG} PANADERIA SUR`)!;
    expect([after.id, after.categories]).toEqual([before.id, ["food (own)"]]);
    expect(r.months[0]!.restatement_carry?.own_categories.map((o) => o.category)).toEqual(["food"]);
  }));

  it("names the new spelling as the catalog named the old one, and the rule follows it", inRollback(() => {
    catalogEntry(`${TAG} TIENDA UNO`, "Tienda Uno Ejemplo");
    rule("TIENDA UNO EJEMPLO", "clothes");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-11`, -9_000, `${TAG} TIENDA UNO`)])));
    const before = shown().get(`${TAG} TIENDA UNO`)!;
    expect([before.name, before.categories]).toEqual([{ kind: "text", text: "Tienda Uno Ejemplo" }, ["clothes (rule)"]]);
    const details = importAgain([mv(`${MONTH}-11`, -9_000, `${TAG} TIENDAUNO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    const after = shown().get(`${TAG} TIENDAUNO`)!;
    expect([after.id, after.name, after.categories]).toEqual([before.id, { kind: "text", text: "Tienda Uno Ejemplo" }, ["clothes (rule)"]]);
    expect(
      db.prepare(`SELECT display FROM vendor_catalog WHERE match_kind = 'exact' AND pattern = ? AND source = 'spelling'`).get(`${TAG} TIENDAUNO`)
    ).toEqual({ display: "Tienda Uno Ejemplo" });
    expect(details.report.join("\n")).toMatch(/catalog spelling added: «VITEST CARRY TIENDAUNO» → «Tienda Uno Ejemplo»/);
  }));

  it("never touches a category the user set on the row", inRollback(() => {
    rule(`${TAG} FERIA`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-12`, -4_000, `${TAG} FERIA`)])));
    const row = shown().get(`${TAG} FERIA`)!;
    putFlowCategory(checkingAccountId(), checkingGastosMovementPurchaseKey(row.id), categoryId("hobbies"), "replace");
    expect(shown().get(`${TAG} FERIA`)!.categories).toEqual(["hobbies (own)"]);
    const details = importAgain([mv(`${MONTH}-12`, -4_000, `${TAG} FERIA LIBRE`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    expect(shown().get(`${TAG} FERIA LIBRE`)!.categories).toEqual(["hobbies (own)"]);
    expect(details.report.join("\n")).not.toMatch(/keeps its category/);
  }));

  it("refuses the month, naming the row, when the new text would take a category the carry cannot keep", inRollback(() => {
    rule(`${TAG} TIENDA DOS`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-13`, -6_000, `${TAG} TIENDA DOS`)])));
    const before = shown();
    // Read as a card payment, the row leaves the expenses: its category has no line to stay on.
    const details = importAgain([mv(`${MONTH}-13`, -6_000, `${TAG} PAGO TARJETA DE CREDITO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["refused"]);
    expect(details.files[0]!.problems.join("\n")).toMatch(/expense line checking\|\d+\|gastos.*food \(rule\) → —/);
    expect(shown()).toEqual(before);
  }));
});
