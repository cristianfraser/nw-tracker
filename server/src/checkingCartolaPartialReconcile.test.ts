import { FLOW_CATEGORY_ROWS_SQL, uniqueCategoryInsert } from "./test/flowFixtures.js";
import { READ_AFTER_ROWS } from "./test/listingFetch.js";
import { describe, expect, it } from "vitest";
import { billLinkPurchaseKey, insertBillLink } from "./flows/flowLinks.js";
import { db } from "./db.js";
import { stateListingFactsOfFixtures } from "./test/dailyListingFacts.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { movementNote } from "./checkingCartolaParse.js";
import { getCcExpenseCategoryBySlug } from "./ccExpenseCategories.js";
import {
  importCheckingPartialMovements,
  partialMovementNote,
} from "./checkingPartialMovementsImport.js";
import { checkingMovementPurchaseKey } from "./expenseKeys.js";
import { buildCheckingGastosLines } from "./flowsCheckingGastos.js";
import { createRealEstatePlace } from "./flowsRealEstateExpenses.js";
import { insertBankPesoMovement } from "./movementWrites.js";
import { dailyListingFacts } from "./movementListingFacts.js";
import { checkingMovementContentMatches, partialDescriptionsMatch } from "./checkingCartolaPartialReconcile.js";
import { withAgreeingBalances } from "./test/cartolaFixtureBalances.js";

function testCheckingAccountId(): number | null {
  const row = db
    .prepare(
      `SELECT a.id FROM accounts a
       JOIN asset_groups g ON g.id = a.asset_group_id
       WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`
    )
    .get() as { id: number } | undefined;
  return row?.id ?? null;
}

/**
 * A cartola month of `movements` whose printed balances agree with the ledger as it stands
 * (`withAgreeingBalances`: build it right before its import).
 */
function cartolaOf(periodMonth: string, movements: ParsedCheckingCartola["movements"]): ParsedCheckingCartola {
  const accountId = testCheckingAccountId();
  if (accountId == null) throw new Error("no checking account in the test person");
  return withAgreeingBalances(accountId, {
    source_file: `vitest-partial-${periodMonth}.xlsx`,
    period_month: periodMonth,
    period_from: `${periodMonth}-01`,
    period_to: `${periodMonth}-28`,
    saldo_inicial_clp: null,
    saldo_final_clp: null,
    movements,
    skipped: [],
    notes: [],
  });
}

/** A daily-listing row as the daily listing's import writes it. */
function dailyRow(accountId: number, mv: { occurred_on: string; amount_clp: number; description: string; document_no: string }): number {
  return insertBankPesoMovement({ accountId, amount: mv.amount_clp, occurredOn: mv.occurred_on, note: partialMovementNote(mv), flowKind: null, listed: dailyListingFacts(mv) });
}

function removeMonth(accountId: number, periodMonth: string, notes: string[]): void {
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(accountId, periodMonth);
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND (note LIKE ? OR note IN (${notes.map(() => "?").join(",") || "''"}))`).run(
    accountId,
    `import:cartola|${periodMonth}|%`,
    ...notes
  );
}

describe("checkingCartolaPartialReconcile", () => {
  it("matches últimos-vs-cartola description variants (June 2026 regression pairs)", () => {
    // Real pairs from the June 2026 import where the strict matcher left duplicates.
    // case only
    expect(
      partialDescriptionsMatch("0768106274 TRANSF. FINTUAL AGF", "0768106274 Transf. Fintual AGF")
    ).toBe(true);
    // cartola truncates the tail
    expect(
      partialDescriptionsMatch(
        "0768106274 TRANSF A FINTUAL ADMINISTRADORA GENERAL DE FONDO",
        "0768106274 Transf a FINTUAL ADMINISTRADORA G"
      )
    ).toBe(true);
    // últimos truncates the tail (reverse direction)
    expect(
      partialDescriptionsMatch(
        "0012345678 Transf. Pedro Pablo Perez",
        "0012345678 TRANSF. PEDRO PABLO PEREZ GONZALEZ"
      )
    ).toBe(true);
    // cartola marker prefix
    expect(partialDescriptionsMatch("Giro Nacional VD", "*/Giro Nacional VD")).toBe(true);
    // diverging mojibake for accents
    expect(
      partialDescriptionsMatch(
        "0177670952 TRANSF A SEBASTIÃ,N SCHUCHHARDT",
        "0177670952 Transf a SebastiÃ¡n Schuchhardt"
      )
    ).toBe(true);
    // different counterparties must NOT match
    expect(
      partialDescriptionsMatch(
        "0194904959 TRANSF A JORGE BRITO",
        "0194904959 Transf a JORGE DANIEL EMILIA"
      )
    ).toBe(false);
    // degenerate short prefixes must NOT match
    expect(partialDescriptionsMatch("Transf", "Transf a FINTUAL ADMINISTRADORA G")).toBe(false);

    // Documents that disagree across sources (counterparty account vs bank doc) must not veto.
    expect(
      checkingMovementContentMatches(
        {
          occurred_on: "2026-06-08",
          amount_clp: 6_000_000,
          description: "0768106274 TRANSF. FINTUAL AGF",
          document_no: "0768106274",
        },
        {
          occurred_on: "2026-06-08",
          amount_clp: 6_000_000,
          description: "0768106274 Transf. Fintual AGF",
          document_no: "6000000",
        }
      )
    ).toBe(true);
  });

  it("removes partial rows when official cartola is imported", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "1800-02";
    const occurredOn = "1800-02-27";
    const amountClp = -27_282;
    const description = "COM.MANTENCION PLAN";
    const partialNote = partialMovementNote({
      occurred_on: occurredOn,
      amount_clp: amountClp,
      description,
      document_no: "",
    });

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(
      accountId,
      partialNote,
      `import:cartola|${periodMonth}|%`
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );

    // The daily row as the daily listing's import writes it (its listing facts on its evidence).
    const partialId = insertBankPesoMovement({
      accountId,
      amount: amountClp,
      occurredOn,
      note: partialNote,
      flowKind: null,
      listed: dailyListingFacts({ occurred_on: occurredOn, amount_clp: amountClp, description, document_no: "" }),
    });

    const cartola: ParsedCheckingCartola = {
      source_file: "vitest-partial-reconcile.xlsx",
      period_month: periodMonth,
      period_from: "1800-02-01",
      period_to: "1800-02-28",
      saldo_inicial_clp: 50_000,
      saldo_final_clp: 22_718,
      movements: [
        {
          occurred_on: occurredOn,
          amount_clp: amountClp,
          branch: "Agustinas",
          description,
          document_no: "",
        },
      ],
      skipped: [],
      notes: [],
    };

    // The daily row is restated as the cartola's row in place: no row written, none deleted.
    const { partialsRestated, partialsRemoved, movementsInserted } = importCheckingCartola(accountId, withAgreeingBalances(accountId, cartola));
    expect([movementsInserted, partialsRestated, partialsRemoved]).toEqual([0, 1, 0]);

    const partial = db
      .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`)
      .get(accountId, partialNote);
    expect(partial).toBeUndefined();

    const official = db
      .prepare(`SELECT id, note FROM movements WHERE account_id = ? AND note LIKE ?`)
      .get(accountId, `import:cartola|${periodMonth}|%`) as { id: number; note: string };
    expect(official.note).toContain(description);
    expect(official.id).toBe(partialId);

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );
  });

  it("moves a payslip link and an income classification onto the cartola row", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;
    const periodMonth = "1801-09";
    const occurredOn = "1801-09-30";
    const amountClp = 1_234_567;
    const description = "0076000000K REMUNERACIONES SEPTIEMBRE 1801";
    const partialNote = partialMovementNote({ occurred_on: occurredOn, amount_clp: amountClp, description, document_no: "" });
    const sourcePdf = "vitest/liquidaciones/1801-09.pdf";
    const cleanup = () => {
      db.prepare(`DELETE FROM payroll_work_earnings WHERE source_pdf = ?`).run(sourcePdf);
      db.prepare(
        `DELETE FROM flow_income_overrides WHERE flow_id IN (
           SELECT flow_id FROM movements WHERE account_id = ? AND (note = ? OR note LIKE ?))`
      ).run(accountId, partialNote, `import:cartola|${periodMonth}|%`);
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(accountId, periodMonth);
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND (note = ? OR note LIKE ?)`).run(
        accountId,
        partialNote,
        `import:cartola|${periodMonth}|%`
      );
    };
    cleanup();

    const partialId = insertBankPesoMovement({
      accountId,
      amount: amountClp,
      occurredOn,
      note: partialNote,
      flowKind: null,
      listed: dailyListingFacts({ occurred_on: occurredOn, amount_clp: amountClp, description, document_no: "" }),
    });
    db.prepare(
      `INSERT INTO payroll_work_earnings (period_month, employer_name, liquido, source_pdf, movement_id, link_source)
       VALUES (?, 'Vitest Employer', ?, ?, ?, 'auto')`
    ).run(periodMonth, amountClp, sourcePdf, partialId);
    db.prepare(
      `INSERT INTO flow_income_overrides (flow_id, income_kind) VALUES ((SELECT flow_id FROM movements WHERE id = ?), 'salary')`
    ).run(partialId);

    try {
      const { partialsRestated } = importCheckingCartola(accountId, withAgreeingBalances(accountId, {
        source_file: "vitest-partial-payslip.xlsx",
        period_month: periodMonth,
        period_from: "1801-09-01",
        period_to: "1801-09-30",
        saldo_inicial_clp: 0,
        saldo_final_clp: amountClp,
        movements: [{ occurred_on: occurredOn, amount_clp: amountClp, branch: "Agustinas", description, document_no: "" }],
        skipped: [],
        notes: [],
      }));
      expect(partialsRestated).toBe(1);
      const official = db
        .prepare(`SELECT id FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(accountId, `import:cartola|${periodMonth}|%`) as { id: number };
      // The daily row became the cartola row: the payslip names the same row.
      expect(official.id).toBe(partialId);
      expect(
        db.prepare(`SELECT movement_id FROM payroll_work_earnings WHERE source_pdf = ?`).get(sourcePdf)
      ).toEqual({ movement_id: official.id });
      expect(
        db
          .prepare(`SELECT o.income_kind FROM flow_income_overrides o JOIN movements m ON m.flow_id = o.flow_id WHERE m.id = ?`)
          .get(official.id)
      ).toEqual({ income_kind: "salary" });
    } finally {
      cleanup();
    }
  });

  it("skips partial import when matching cartola movement exists", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "2099-08";
    const occurredOn = "2099-08-27";
    const amountClp = -27_282;
    const description = "COM.MANTENCION PLAN";
    const officialNote = movementNote(periodMonth, "Agustinas", description, "", {
      occurredOn,
      amountClp,
      cartolaIndex: 0,
    });

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    ).run(accountId, amountClp, occurredOn, officialNote);
    stateListingFactsOfFixtures();

    const result = importCheckingPartialMovements(accountId, [
      {
        occurred_on: occurredOn,
        amount_clp: amountClp,
        description,
        document_no: "",
      },
    ], READ_AFTER_ROWS);
    expect(result.inserted).toBe(0);
    expect(result.skipped_superseded_by_cartola).toBe(1);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
  });

  it("a cartola leaves a daily row it does not list, and is refused while that row puts the month off its balances", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;
    const unrelated = { occurred_on: "1800-05-01", amount_clp: -1000, description: "Unrelated partial only", document_no: "" };
    removeMonth(accountId, "1800-05", [partialMovementNote(unrelated)]);
    const row = dailyRow(accountId, unrelated);
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`).get(accountId) as { n: number }).n;
    try {
      // The bank does not list the daily row: the month on file is the cartola's money plus that row.
      expect(() =>
        importCheckingCartola(accountId, cartolaOf("1800-05", [{ occurred_on: "1800-05-02", amount_clp: -2000, branch: "", description: "Other cartola move", document_no: "" }]))
      ).toThrow(/1800-05 .*refused: the ledger at 1800-04-30 .*ledger − cartola = 1000/);
      expect(db.prepare(`SELECT note FROM movements WHERE id = ?`).get(row)).toEqual({ note: partialMovementNote(unrelated) });
      expect((db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE account_id = ?`).get(accountId) as { n: number }).n).toBe(before);
    } finally {
      removeMonth(accountId, "1800-05", [partialMovementNote(unrelated)]);
    }
  });

  it("keeps a daily row's Único category on the cartola row it becomes", () => {
    const accountId = testCheckingAccountId();
    const bills = getCcExpenseCategoryBySlug("bills");
    if (accountId == null || bills == null) return;
    const periodMonth = "1800-03";
    const listed = { occurred_on: "1800-03-15", amount_clp: -76_282, description: "0560112904 TRANSF A COMUNIDAD EDIFICIO", document_no: "0560112904" };
    removeMonth(accountId, periodMonth, [partialMovementNote(listed)]);
    const partialId = dailyRow(accountId, listed);
    uniqueCategoryInsert.run(accountId, checkingMovementPurchaseKey(partialId), bills.id);
    const stableKey = `checking-cartola:${accountId}:${periodMonth}:${listed.occurred_on}:${listed.amount_clp}:0`;
    try {
      const r = importCheckingCartola(accountId, cartolaOf(periodMonth, [{ ...listed, branch: "Agustinas" }]));
      expect(r.partialsRestated).toBe(1);
      const migrated = db
        .prepare(
          `SELECT c.slug FROM ${FLOW_CATEGORY_ROWS_SQL} up
           JOIN cc_expense_categories c ON c.id = up.category_id
           WHERE up.account_id = ? AND up.purchase_key = ?`
        )
        .get(accountId, stableKey) as { slug: string } | undefined;
      expect(migrated?.slug).toBe("bills");
      expect(db.prepare(`SELECT note LIKE 'import:cartola|%' AS cartola FROM movements WHERE id = ?`).get(partialId)).toEqual({ cartola: 1 });
    } finally {
      db.prepare(
        `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
      ).run(accountId, stableKey);
      removeMonth(accountId, periodMonth, [partialMovementNote(listed)]);
    }
  });

  it("keeps a place bill's link on the cartola row a daily row becomes", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;
    const periodMonth = "1800-04";
    const listed = { occurred_on: "1800-04-15", amount_clp: -81_103, description: "TRANSF A COMUNIDAD EDIFICIO VITEST", document_no: "0560112904" };
    removeMonth(accountId, periodMonth, [partialMovementNote(listed)]);
    db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_cartola_place'`).run();
    const partialId = dailyRow(accountId, listed);
    createRealEstatePlace({ slug: "vitest_cartola_place", label: "Vitest cartola" });
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO expense_entries (amount, spent_on, category, note, expense_account_id)
           VALUES (68200, '1800-03-31', 'gastos_comunes', 'vitest',
                   (SELECT id FROM expense_accounts WHERE slug = 'vitest_cartola_place'))`
        )
        .run().lastInsertRowid
    );
    insertBillLink(entryId, checkingMovementPurchaseKey(partialId), "manual");
    try {
      const r = importCheckingCartola(accountId, cartolaOf(periodMonth, [{ ...listed, branch: "Agustinas" }]));
      expect(r.partialsRestated).toBe(1);
      expect(billLinkPurchaseKey(entryId)).toBe(`checking-cartola:${accountId}:${periodMonth}:${listed.occurred_on}:${listed.amount_clp}:0`);
    } finally {
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
      db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_cartola_place'`).run();
      removeMonth(accountId, periodMonth, [partialMovementNote(listed)]);
    }
  });

  it("daily-listing withdrawals appear in gastos", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const occurredOn = "1800-04-11";
    const amountClp = -77_621;
    const description = "0560112904 Transf a COMUNIDAD EDIFICIO";
    const partialNote = partialMovementNote({
      occurred_on: occurredOn,
      amount_clp: amountClp,
      description,
      document_no: "0560112904",
    });

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      partialNote
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    ).run(accountId, amountClp, occurredOn, partialNote);
    stateListingFactsOfFixtures();

    const lines = buildCheckingGastosLines({ accountId });
    const hit = lines.find(
      (ln) => ln.expense_month === "1800-04" && ln.merchant_key?.includes("COMUNIDAD EDIFICIO")
    );
    expect(hit?.amount_clp).toBe(77_621);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      partialNote
    );
  });
});
