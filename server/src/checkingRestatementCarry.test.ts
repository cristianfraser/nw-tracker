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
  it("passes a rule over to the new spelling when the new text no longer reaches it, and reports it", inRollback(() => {
    rule(`${TAG} KIOSKO`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSKO`)])));
    const before = shown().get(`${TAG} KIOSKO`)!;
    expect(before.categories).toEqual(["food (rule)"]);
    const details = importAgain([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSCO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    const after = shown().get(`${TAG} KIOSCO`)!;
    expect([after.id, after.categories]).toEqual([before.id, ["food (rule)"]]);
    expect(db.prepare(`SELECT origin FROM expense_category_rules WHERE vendor = ? AND link_kind = ''`).get(`${TAG} KIOSCO`)).toEqual({ origin: "cartola_spelling" });
    expect(details.report.join("\n")).toMatch(/rule passed to the new spelling: «VITEST CARRY KIOSCO» → food/);
  }));

  it("keeps the category as the row's own when the new spelling's vendor has a rule of its own", inRollback(() => {
    rule(`${TAG} KIOSKO`, "food");
    rule(`${TAG} KIOSCO`, "fun");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSKO`)])));
    const details = importAgain([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSCO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    expect(shown().get(`${TAG} KIOSCO`)!.categories).toEqual(["food (own)"]);
    expect(details.report.join("\n")).toMatch(/KEPT AS ITS OWN: movement \d+ → food \(was rule/);
  }));

  it("does not pass a rule that would move another line's category: the row keeps it as its own", inRollback(() => {
    rule(`${TAG} KIOSKO`, "food");
    // Another month's row already reads as the new spelling, with no category.
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSKO`), mv(`${MONTH}-11`, -1_000, `${TAG} KIOSCO`)])));
    const details = importAgain([mv(`${MONTH}-10`, -3_000, `${TAG} KIOSCO`), mv(`${MONTH}-11`, -1_000, `${TAG} KIOSCO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    clearAggregationCache();
    const rows = [...snapshotExpenseIdentity(checkingAccountId(), [MONTH]).rows.values()];
    expect(rows.map((r) => [r.amount_clp, [...r.lines.values()].map((l) => `${l.slug} (${l.source})`)])).toEqual([
      [-3_000, ["food (own)"]],
      [-1_000, ["unclassified (none)"]],
    ]);
  }));

  it("carries the same way on the ledger rebuild (the repair of a month imported twice)", inRollback(() => {
    rule(`CENTRO ${TAG} PANADERIA`, "food");
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-14`, -2_500, `Centro ${TAG} PANADERIA`)])));
    const before = shown().get(`Centro ${TAG} PANADERIA`)!;
    expect(before.categories).toEqual(["food (rule)"]);
    clearAggregationCache();
    const r = rebuildCheckingLedgerFromCartolas(checkingAccountId(), [parsedCartolaFromStatement(statement([mv(`${MONTH}-14`, -2_500, `${TAG} PANADERIA SUR`)]))]);
    const after = shown().get(`${TAG} PANADERIA SUR`)!;
    expect([after.id, after.categories]).toEqual([before.id, ["food (rule)"]]);
    expect(r.months[0]!.restatement_carry?.rules_passed.map((o) => o.category)).toEqual(["food"]);
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

  it("refuses the spelling when another line reads the same text: naming it would rename that line", inRollback(() => {
    catalogEntry(`${TAG} TIENDA TRES`, "Tienda Tres Ejemplo");
    applyBankAccountStatements(
      payload(statement([mv(`${MONTH}-11`, -9_000, `${TAG} TIENDA TRES`), mv(`${MONTH}-15`, -1_000, `${TAG} TIENDATRES`)]))
    );
    const details = importAgain([mv(`${MONTH}-11`, -9_000, `${TAG} TIENDATRES`), mv(`${MONTH}-15`, -1_000, `${TAG} TIENDATRES`)]);
    expect(details.files.map((f) => f.status)).toEqual(["refused"]);
    expect(details.files[0]!.problems.join("\n")).toMatch(/naming «VITEST CARRY TIENDATRES» «Tienda Tres Ejemplo» would rename 1 other line/);
  }));

  it("never overwrites a spelling already in the catalog: the row reads it, and the change is reported", inRollback(() => {
    catalogEntry(`${TAG} TIENDA CUATRO`, "Tienda Cuatro Ejemplo");
    db.prepare(`INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES ('exact', ?, 'Otra Tienda', 'spelling')`).run(`${TAG} TIENDACUATRO`);
    applyBankAccountStatements(payload(statement([mv(`${MONTH}-16`, -9_000, `${TAG} TIENDA CUATRO`)])));
    const details = importAgain([mv(`${MONTH}-16`, -9_000, `${TAG} TIENDACUATRO`)]);
    expect(details.files.map((f) => f.status)).toEqual(["imported"]);
    expect(db.prepare(`SELECT display FROM vendor_catalog WHERE source = 'spelling' AND pattern = ?`).get(`${TAG} TIENDACUATRO`)).toEqual({ display: "Otra Tienda" });
    expect(details.report.join("\n")).toMatch(/shown name now: movement \d+ «Tienda Cuatro Ejemplo» → «Otra Tienda»/);
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
