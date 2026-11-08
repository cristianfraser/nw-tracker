import { FLOW_CATEGORY_ROWS_SQL, uniqueCategoryInsert } from "./test/flowFixtures.js";
import { describe, expect, it } from "vitest";
import { billLinkPurchaseKey, insertBillLink } from "./flows/flowLinks.js";
import { db } from "./db.js";
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
import {
  checkingMovementContentMatches,
  parsePartialMovementNote,
  partialDescriptionsMatch,
  prunePartialMovementsSupersededByCartola,
  reconcileCartolaPartialImports,
} from "./checkingCartolaPartialReconcile.js";

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

describe("checkingCartolaPartialReconcile", () => {
  it("parses partial movement notes", () => {
    expect(
      parsePartialMovementNote("import:cartola-partial|2026-05-27|-27282|COM.MANTENCION PLAN")
    ).toEqual({
      occurred_on: "2026-05-27",
      amount_clp: -27282,
      description: "COM.MANTENCION PLAN",
      document_no: "",
    });
    expect(
      parsePartialMovementNote(
        "import:cartola-partial|2026-05-11|-77621|0560112904 Transf a COMUNIDAD EDIFICIO|doc:5592808"
      )
    ).toEqual({
      occurred_on: "2026-05-11",
      amount_clp: -77621,
      description: "0560112904 Transf a COMUNIDAD EDIFICIO",
      document_no: "5592808",
    });
  });

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
        "0011111111 Transf. Juan Alejandro Perez",
        "0011111111 TRANSF. JUAN ALEJANDRO PEREZ SOTO"
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

    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    ).run(accountId, amountClp, occurredOn, partialNote);

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

    const { partialsRemoved, movementsInserted } = importCheckingCartola(accountId, cartola);
    expect(movementsInserted).toBe(1);
    expect(partialsRemoved).toBe(1);

    const partial = db
      .prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`)
      .get(accountId, partialNote);
    expect(partial).toBeUndefined();

    const official = db
      .prepare(`SELECT note FROM movements WHERE account_id = ? AND note LIKE ?`)
      .get(accountId, `import:cartola|${periodMonth}|%`) as { note: string };
    expect(official.note).toContain(description);

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

    const partialId = Number(
      db
        .prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`)
        .run(accountId, amountClp, occurredOn, partialNote).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO payroll_work_earnings (period_month, employer_name, liquido, source_pdf, movement_id, link_source)
       VALUES (?, 'Vitest Employer', ?, ?, ?, 'auto')`
    ).run(periodMonth, amountClp, sourcePdf, partialId);
    db.prepare(
      `INSERT INTO flow_income_overrides (flow_id, income_kind) VALUES ((SELECT flow_id FROM movements WHERE id = ?), 'salary')`
    ).run(partialId);

    try {
      const { partialsRemoved } = importCheckingCartola(accountId, {
        source_file: "vitest-partial-payslip.xlsx",
        period_month: periodMonth,
        period_from: "1801-09-01",
        period_to: "1801-09-30",
        saldo_inicial_clp: 0,
        saldo_final_clp: amountClp,
        movements: [{ occurred_on: occurredOn, amount_clp: amountClp, branch: "Agustinas", description, document_no: "" }],
        skipped: [],
        notes: [],
      });
      expect(partialsRemoved).toBe(1);
      const official = db
        .prepare(`SELECT id FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(accountId, `import:cartola|${periodMonth}|%`) as { id: number };
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

  it("reconciles partial rows on skipped cartola re-import", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "2099-07";
    const occurredOn = "2099-07-27";
    const amountClp = -27_282;
    const description = "COM.MANTENCION PLAN";
    const partialNote = partialMovementNote({
      occurred_on: occurredOn,
      amount_clp: amountClp,
      description,
      document_no: "",
    });
    const officialNote = movementNote(periodMonth, "Agustinas", description, "", {
      occurredOn,
      amountClp,
      cartolaIndex: 0,
    });

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND (note = ? OR note = ?)`).run(
      accountId,
      partialNote,
      officialNote
    );

    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL), (?, ?, 'clp', ?, ?, NULL)`
    ).run(
      accountId,
      amountClp,
      occurredOn,
      officialNote,
      accountId,
      amountClp,
      occurredOn,
      partialNote
    );
    db.prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_final_clp, saldo_inicial_clp, period_from, period_to
       ) VALUES (?, ?, ?, 1, 22000, 50000, '2099-07-01', '2099-07-31')`
    ).run(accountId, periodMonth, "vitest-already-imported.xlsx");

    const { removed } = reconcileCartolaPartialImports(accountId, [
      {
        occurred_on: occurredOn,
        amount_clp: amountClp,
        branch: "Agustinas",
        description,
        document_no: "",
      },
    ]);
    expect(removed).toBe(1);
    expect(
      db.prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`).get(
        accountId,
        partialNote
      )
    ).toBeUndefined();

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
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

    const result = importCheckingPartialMovements(accountId, [
      {
        occurred_on: occurredOn,
        amount_clp: amountClp,
        description,
        document_no: "",
      },
    ]);
    expect(result.inserted).toBe(0);
    expect(result.skipped_superseded_by_cartola).toBe(1);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
  });

  it("prunePartialMovementsSupersededByCartola leaves unrelated partial rows", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const unrelatedNote = partialMovementNote({
      occurred_on: "2099-09-01",
      amount_clp: -1000,
      description: "Unrelated partial only",
      document_no: "",
    });
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      unrelatedNote
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, -1000, 'clp', '2099-09-01', ?, NULL)`
    ).run(accountId, unrelatedNote);

    const { removed } = prunePartialMovementsSupersededByCartola(accountId, [
      {
        occurred_on: "2099-09-02",
        amount_clp: -2000,
        branch: "",
        description: "Other cartola move",
        document_no: "",
      },
    ]);
    expect(removed).toBe(0);
    expect(
      db.prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`).get(
        accountId,
        unrelatedNote
      )
    ).toBeDefined();

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      unrelatedNote
    );
  });

  it("migrates Único category from partial to official cartola on reconcile", () => {
    const accountId = testCheckingAccountId();
    const bills = getCcExpenseCategoryBySlug("bills");
    if (accountId == null || bills == null) return;

    const periodMonth = "1800-03";
    const occurredOn = "1800-03-15";
    const amountClp = -76_282;
    const description = "0560112904 TRANSF A COMUNIDAD EDIFICIO";
    const partialNote = partialMovementNote({
      occurred_on: occurredOn,
      amount_clp: amountClp,
      description,
      document_no: "0560112904",
    });
    const officialNote = movementNote(periodMonth, "Agustinas", description, "0560112904", {
      occurredOn,
      amountClp,
      cartolaIndex: 0,
    });

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(
      accountId,
      partialNote,
      officialNote
    );

    const partialInsert = db
      .prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
         VALUES (?, ?, 'clp', ?, ?, NULL)`
      )
      .run(accountId, amountClp, occurredOn, partialNote);
    const partialId = Number(partialInsert.lastInsertRowid);

    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    ).run(accountId, amountClp, occurredOn, officialNote);

    uniqueCategoryInsert.run(accountId, checkingMovementPurchaseKey(partialId), bills.id);

    const { removed } = prunePartialMovementsSupersededByCartola(accountId, [
      {
        occurred_on: occurredOn,
        amount_clp: amountClp,
        branch: "Agustinas",
        description,
        document_no: "0560112904",
      },
    ]);
    expect(removed).toBe(1);

    const stableKey = `checking-cartola:${accountId}:${periodMonth}:${occurredOn}:${amountClp}:0`;
    const migrated = db
      .prepare(
        `SELECT c.slug FROM ${FLOW_CATEGORY_ROWS_SQL} up
         JOIN cc_expense_categories c ON c.id = up.category_id
         WHERE up.account_id = ? AND up.purchase_key = ?`
      )
      .get(accountId, stableKey) as { slug: string } | undefined;
    expect(migrated?.slug).toBe("bills");
    expect(
      db.prepare(`SELECT 1 AS o FROM movements WHERE account_id = ? AND note = ?`).get(
        accountId,
        partialNote
      )
    ).toBeUndefined();

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(
      accountId,
      officialNote
    );
    db.prepare(
      `DELETE FROM flow_categories WHERE rowid IN (SELECT rid FROM ${FLOW_CATEGORY_ROWS_SQL} WHERE account_id = ? AND purchase_key = ?)`
    ).run(accountId, stableKey);
  });

  it("moves a place bill's link from the partial row onto the cartola row", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "1800-04";
    const occurredOn = "1800-04-15";
    const amountClp = -81_103;
    const description = "TRANSF A COMUNIDAD EDIFICIO VITEST";
    const partialNote = partialMovementNote({
      occurred_on: occurredOn,
      amount_clp: amountClp,
      description,
      document_no: "0560112904",
    });
    const officialNote = movementNote(periodMonth, "Agustinas", description, "0560112904", {
      occurredOn,
      amountClp,
      cartolaIndex: 0,
    });
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(accountId, partialNote, officialNote);
    db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_cartola_place'`).run();

    const partialId = Number(
      db
        .prepare(
          `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
           VALUES (?, ?, 'clp', ?, ?, NULL)`
        )
        .run(accountId, amountClp, occurredOn, partialNote).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, units_delta)
       VALUES (?, ?, 'clp', ?, ?, NULL)`
    ).run(accountId, amountClp, occurredOn, officialNote);
    createRealEstatePlace({ slug: "vitest_cartola_place", label: "Vitest cartola" });
    const entryId = Number(
      db
        .prepare(
          `INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id)
           VALUES (68200, '1800-03-31', 'gastos_comunes', 'vitest',
                   (SELECT id FROM expense_accounts WHERE slug = 'vitest_cartola_place'))`
        )
        .run().lastInsertRowid
    );
    insertBillLink(entryId, checkingMovementPurchaseKey(partialId), "manual");

    try {
      const { removed } = prunePartialMovementsSupersededByCartola(accountId, [
        { occurred_on: occurredOn, amount_clp: amountClp, branch: "Agustinas", description, document_no: "0560112904" },
      ]);
      expect(removed).toBe(1);
      expect(billLinkPurchaseKey(entryId)).toBe(`checking-cartola:${accountId}:${periodMonth}:${occurredOn}:${amountClp}:0`);
    } finally {
      db.prepare(`DELETE FROM expense_entries WHERE id = ?`).run(entryId);
      db.prepare(`DELETE FROM expense_accounts WHERE slug = 'vitest_cartola_place'`).run();
      db.prepare(`DELETE FROM movements WHERE account_id = ? AND note IN (?, ?)`).run(accountId, partialNote, officialNote);
    }
  });

  it("partial withdrawals appear in gastos until superseded by cartola", () => {
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
