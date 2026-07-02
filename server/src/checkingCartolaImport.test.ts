import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  importCheckingCartola,
  isPhantomBoundaryMonthImport,
  prunePhantomBoundaryMonthCartolaImports,
  pruneStaleCartolaMonthImportsForSourceFile,
  rewriteCartolaMovementNotesPeriodMonth,
  shouldBackfillCartolaSaldoRef,
  updateCheckingCartolaImportSaldos,
} from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

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

function latestSaldoFinalClp(accountId: number): number {
  const row = db
    .prepare(
      `SELECT saldo_final_clp FROM checking_cartola_imports
       WHERE account_id = ? AND saldo_final_clp IS NOT NULL
       ORDER BY period_month DESC LIMIT 1`
    )
    .get(accountId) as { saldo_final_clp: number } | undefined;
  return row ? Math.round(row.saldo_final_clp) : 0;
}

describe("checkingCartolaImport", () => {
  it("rewriteCartolaMovementNotesPeriodMonth updates note prefixes", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const oldMonth = "2099-01";
    const newMonth = "2099-02";
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-%`
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, 100, '2099-01-15', ?, NULL)`
    ).run(accountId, `import:cartola|${oldMonth}|Agustinas|Test|on:2099-01-15|amt:100|idx:0`);

    const changed = rewriteCartolaMovementNotesPeriodMonth(accountId, oldMonth, newMonth);
    expect(changed).toBe(1);
    const row = db
      .prepare(`SELECT note FROM movements WHERE account_id = ? AND note LIKE ?`)
      .get(accountId, `import:cartola|${newMonth}|%`) as { note: string };
    expect(row.note).toContain(`import:cartola|${newMonth}|`);

    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-%`
    );
  });

  it("refuses to register a cartola month when saldo changed but no movements parsed", () => {
    const accountId = testCheckingAccountId();
    if (accountId == null) return;

    const periodMonth = "2099-03";
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );

    const cartola: ParsedCheckingCartola = {
      source_file: "vitest-empty-import-guard.xlsx",
      period_month: periodMonth,
      period_from: "2099-03-01",
      period_to: "2099-03-31",
      saldo_inicial_clp: 100_000,
      saldo_final_clp: 200_000,
      movements: [],
      skipped: [],
      notes: [],
    };

    expect(() => importCheckingCartola(accountId, cartola)).toThrow(/saldo identity mismatch/);
    const imp = db
      .prepare(
        `SELECT 1 AS o FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
      )
      .get(accountId, periodMonth);
    expect(imp).toBeUndefined();
  });

  it("backfills saldo referencia without changing movements", () => {
    const accountId = cartolaCashAccountIdOptional("cuenta_vista");
    if (accountId == null) return;

    const periodMonth = "2099-04";
    const sourceFile = "vitest-saldo-backfill.pdf";
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );

    // Chain validation compares saldo_inicial against the account's latest real saldo
    // final — anchor the fixture to it instead of a hardcoded 50.000.
    const chainInicial = latestSaldoFinalClp(accountId);
    const cartola: ParsedCheckingCartola = {
      source_file: sourceFile,
      period_month: periodMonth,
      period_from: "2099-04-01",
      period_to: "2099-04-30",
      saldo_inicial_clp: chainInicial,
      saldo_final_clp: null,
      movements: [
        {
          occurred_on: "2099-04-10",
          amount_clp: -1000,
          branch: "401",
          description: "Test move",
          document_no: "1",
        },
      ],
      skipped: [],
      notes: [],
    };

    importCheckingCartola(accountId, cartola);
    const moveCount = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(accountId, `import:cartola|${periodMonth}|%`) as { c: number }
    ).c;

    const updated: ParsedCheckingCartola = {
      ...cartola,
      saldo_final_clp: chainInicial - 1_000,
      saldo_inicial_clp: chainInicial,
    };
    expect(shouldBackfillCartolaSaldoRef(accountId, updated)).toBe(true);
    updateCheckingCartolaImportSaldos(accountId, updated);

    const row = db
      .prepare(
        `SELECT saldo_final_clp FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
      )
      .get(accountId, periodMonth) as { saldo_final_clp: number };
    expect(row.saldo_final_clp).toBe(chainInicial - 1_000);
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE ?`)
          .get(accountId, `import:cartola|${periodMonth}|%`) as { c: number }
      ).c
    ).toBe(moveCount);

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );
  });

  it("isPhantomBoundaryMonthImport detects old split boundary rows", () => {
    expect(
      isPhantomBoundaryMonthImport({
        period_month: "2016-10",
        period_from: "2016-10-28",
        period_to: "2017-10-31",
        movement_count: 0,
      })
    ).toBe(true);
    expect(
      isPhantomBoundaryMonthImport({
        period_month: "2020-03",
        period_from: "2020-03-31",
        period_to: "2020-04-30",
        movement_count: 0,
      })
    ).toBe(true);
    expect(
      isPhantomBoundaryMonthImport({
        period_month: "2020-04",
        period_from: "2020-03-31",
        period_to: "2020-04-30",
        movement_count: 2,
      })
    ).toBe(false);
    expect(
      isPhantomBoundaryMonthImport({
        period_month: "2019-11",
        period_from: "2019-11-01",
        period_to: "2020-01-31",
        movement_count: 0,
      })
    ).toBe(false);
  });

  it("prunePhantomBoundaryMonthCartolaImports removes zero-movement boundary rows only", () => {
    const accountId = cartolaCashAccountIdOptional("cuenta_vista");
    if (accountId == null) return;

    const phantomMonth = "2099-05";
    const realMonth = "2099-06";
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month IN (?, ?)`).run(
      accountId,
      phantomMonth,
      realMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-0%`
    );

    db.prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_final_clp, saldo_inicial_clp, period_from, period_to
       ) VALUES (?, ?, ?, 0, NULL, 1000, ?, ?)`
    ).run(accountId, phantomMonth, "vitest-phantom.pdf", "2099-05-31", "2099-06-30");

    // Saldo chain: the phantom row carries NULL saldo final, so validation reaches back
    // to the account's latest real saldo final — anchor the fixture there.
    const chainInicial = latestSaldoFinalClp(accountId);
    const realCartola: ParsedCheckingCartola = {
      source_file: "vitest-phantom.pdf",
      period_month: realMonth,
      period_from: "2099-05-31",
      period_to: "2099-06-30",
      saldo_inicial_clp: chainInicial,
      saldo_final_clp: chainInicial - 100,
      movements: [
        {
          occurred_on: "2099-06-10",
          amount_clp: -100,
          branch: "401",
          description: "Test",
          document_no: "1",
        },
      ],
      skipped: [],
      notes: [],
    };
    importCheckingCartola(accountId, realCartola);

    const { pruned } = prunePhantomBoundaryMonthCartolaImports(accountId);
    expect(pruned).toContain(phantomMonth);

    const phantomRow = db
      .prepare(
        `SELECT 1 AS o FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`
      )
      .get(accountId, phantomMonth);
    expect(phantomRow).toBeUndefined();

    const realMoves = (
      db
        .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(accountId, `import:cartola|${realMonth}|%`) as { c: number }
    ).c;
    expect(realMoves).toBe(1);

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      realMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-0%`
    );
  });

  it("pruneStaleCartolaMonthImportsForSourceFile removes months outside valid coverage", () => {
    const accountId = cartolaCashAccountIdOptional("cuenta_vista");
    if (accountId == null) return;

    const sourceFile = "vitest-stale-prune.pdf";
    const staleMonth = "2099-07";
    const keepMonth = "2099-08";
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month IN (?, ?)`).run(
      accountId,
      staleMonth,
      keepMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-0%`
    );

    db.prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_final_clp, saldo_inicial_clp, period_from, period_to
       ) VALUES (?, ?, ?, 1, NULL, NULL, ?, ?)`
    ).run(accountId, staleMonth, sourceFile, "2099-06-30", "2099-08-31");
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, -100, '2099-07-15', ?, NULL)`
    ).run(accountId, `import:cartola|${staleMonth}|401|Stale|on:2099-07-15|amt:-100|idx:0`);

    db.prepare(
      `INSERT INTO checking_cartola_imports (
         account_id, period_month, source_file, movement_count,
         saldo_final_clp, saldo_inicial_clp, period_from, period_to
       ) VALUES (?, ?, ?, 1, NULL, NULL, ?, ?)`
    ).run(accountId, keepMonth, sourceFile, "2099-06-30", "2099-08-31");
    db.prepare(
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
       VALUES (?, 200, '2099-08-10', ?, NULL)`
    ).run(accountId, `import:cartola|${keepMonth}|401|Keep|on:2099-08-10|amt:200|idx:0`);

    const { pruned } = pruneStaleCartolaMonthImportsForSourceFile(accountId, sourceFile, [keepMonth]);
    expect(pruned).toEqual([staleMonth]);

    expect(
      db
        .prepare(`SELECT 1 AS o FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`)
        .get(accountId, staleMonth)
    ).toBeUndefined();
    expect(
      (
        db
          .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE ?`)
          .get(accountId, `import:cartola|${keepMonth}|%`) as { c: number }
      ).c
    ).toBe(1);

    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      keepMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|2099-0%`
    );
  });
});
