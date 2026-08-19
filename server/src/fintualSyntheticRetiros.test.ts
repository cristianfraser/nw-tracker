import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  confirmSyntheticRetiroForTransferLeg,
  listOverdueUnconfirmedSyntheticRetiros,
  recordSyntheticRetiroTransfer,
  syntheticRetiroConfirmationDeadlineYmd,
} from "./fintualSyntheticRetiros.js";
import { importCheckingPartialMovements } from "./checkingPartialMovementsImport.js";
import { importCheckingCartola } from "./checkingCartolaImport.js";
import type { ParsedCheckingCartola } from "./checkingCartolaParse.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";

describe("fintualSyntheticRetiros", () => {
  const createdMovements: number[] = [];
  const createdAccounts: number[] = [];

  afterEach(() => {
    for (const id of createdMovements.splice(0)) {
      // Cascade covers this, but an explicit delete keeps UNIQUE(message_id) clean even if a
      // failed assertion left the movement delete unreached on a previous run.
      db.prepare(`DELETE FROM fintual_synthetic_retiro_transfers WHERE movement_id = ?`).run(id);
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
    for (const id of createdAccounts.splice(0)) {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
    }
  });

  function mkAccount(name: string): number | null {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return null;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at)
       VALUES (?, ?, 0, datetime('now'))`
    ).run(group.id, name);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdAccounts.push(id);
    return id;
  }

  function mkTransfer(fromId: number, toId: number, amount: number, ymd: string): number {
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, ?, 'clp', ?, 'vitest synthetic retiro')`
    ).run(fromId, toId, amount, ymd);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdMovements.push(id);
    return id;
  }

  it("deadline = payment date + 2 Chile business days", () => {
    expect(syntheticRetiroConfirmationDeadlineYmd("2026-08-19")).toBe("2026-08-21"); // Wed → Fri
    expect(syntheticRetiroConfirmationDeadlineYmd("2026-08-21")).toBe("2026-08-25"); // Fri → Tue, weekend skipped
  });

  it("lists a synthesis as overdue only once its deadline passed and it is unconfirmed", () => {
    const goal = mkAccount("vitest synth goal A");
    const bank = mkAccount("vitest synth bank A");
    if (goal == null || bank == null) return;
    const movementId = mkTransfer(goal, bank, 987001, "2026-08-10");
    const messageId = `vitest-overdue-${Date.now()}`;
    recordSyntheticRetiroTransfer(movementId, messageId, 987001, "2026-08-10");

    const overdueOf = (today: string) =>
      listOverdueUnconfirmedSyntheticRetiros(today).filter((o) => o.movement_id === movementId);
    // Paid Monday the 10th → deadline Wednesday the 12th: on time through the deadline day.
    expect(overdueOf("2026-08-12")).toHaveLength(0);
    expect(overdueOf("2026-08-13")).toHaveLength(1);
    expect(overdueOf("2026-08-13")[0]).toMatchObject({
      message_id: messageId,
      paid_on: "2026-08-10",
      deadline: "2026-08-12",
    });

    confirmSyntheticRetiroForTransferLeg(movementId, "2026-08-11", "ultimos_xlsx");
    expect(overdueOf("2026-08-13")).toHaveLength(0);
  });

  it("keeps the first confirmation stamp", () => {
    const goal = mkAccount("vitest synth goal B");
    const bank = mkAccount("vitest synth bank B");
    if (goal == null || bank == null) return;
    const movementId = mkTransfer(goal, bank, 987002, "2026-08-10");
    recordSyntheticRetiroTransfer(movementId, `vitest-first-${Date.now()}`, 987002, "2026-08-10");

    confirmSyntheticRetiroForTransferLeg(movementId, "2026-08-11", "ultimos_xlsx");
    // The monthly cartola re-lists the same credit weeks later — the earlier stamp stands.
    confirmSyntheticRetiroForTransferLeg(movementId, "2026-09-01", "cartola");
    const row = db
      .prepare(
        `SELECT confirmed_on, confirmed_source FROM fintual_synthetic_retiro_transfers WHERE movement_id = ?`
      )
      .get(movementId) as { confirmed_on: string; confirmed_source: string };
    expect(row).toMatchObject({ confirmed_on: "2026-08-11", confirmed_source: "ultimos_xlsx" });
  });

  it("the daily xlsx import stamps the synthesis it skips as superseded_by_transfer", () => {
    const goal = mkAccount("vitest synth goal C");
    const bank = mkAccount("vitest synth bank C");
    if (goal == null || bank == null) return;
    const movementId = mkTransfer(goal, bank, 654400, "2099-07-10");
    recordSyntheticRetiroTransfer(movementId, `vitest-xlsx-${Date.now()}`, 654400, "2099-07-10");

    const res = importCheckingPartialMovements(bank, [
      { occurred_on: "2099-07-10", description: "vitest Transf Fintual", amount_clp: 654400, document_no: "1" },
    ]);
    expect(res.skipped_superseded_by_transfer).toBe(1);
    expect(res.inserted).toBe(0);
    const row = db
      .prepare(
        `SELECT confirmed_on, confirmed_source FROM fintual_synthetic_retiro_transfers WHERE movement_id = ?`
      )
      .get(movementId) as { confirmed_on: string; confirmed_source: string };
    expect(row).toMatchObject({ confirmed_on: "2099-07-10", confirmed_source: "ultimos_xlsx" });
  });

  it("the monthly cartola import stamps the synthesis it skips", () => {
    const accountId = cartolaCashAccountIdOptional("cuenta_vista");
    if (accountId == null) return;
    const goal = mkAccount("vitest synth goal D");
    if (goal == null) return;

    const periodMonth = "2099-06";
    db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
      accountId,
      periodMonth
    );
    db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
      accountId,
      `import:cartola|${periodMonth}|%`
    );
    // Chain validation compares saldo_inicial against the account's latest real saldo final.
    const latest = db
      .prepare(
        `SELECT saldo_final_clp FROM checking_cartola_imports
         WHERE account_id = ? AND saldo_final_clp IS NOT NULL
         ORDER BY period_month DESC LIMIT 1`
      )
      .get(accountId) as { saldo_final_clp: number } | undefined;
    const chainInicial = latest ? Math.round(latest.saldo_final_clp) : 0;

    const movementId = mkTransfer(goal, accountId, 777888, "2099-06-15");
    recordSyntheticRetiroTransfer(movementId, `vitest-cartola-${Date.now()}`, 777888, "2099-06-15");

    const cartola: ParsedCheckingCartola = {
      source_file: "vitest-synth-retiro.pdf",
      period_month: periodMonth,
      period_from: "2099-06-01",
      period_to: "2099-06-30",
      saldo_inicial_clp: chainInicial,
      saldo_final_clp: chainInicial + 777888,
      movements: [
        {
          occurred_on: "2099-06-15",
          amount_clp: 777888,
          branch: "401",
          description: "vitest Transf Fintual AGF",
          document_no: "7",
        },
      ],
      skipped: [],
      notes: [],
    };
    try {
      const res = importCheckingCartola(accountId, cartola);
      expect(res.movementsInserted).toBe(0);
      expect(res.skipped_flows.some((f) => f.reason === "superseded_by_transfer")).toBe(true);
      const row = db
        .prepare(
          `SELECT confirmed_on, confirmed_source FROM fintual_synthetic_retiro_transfers WHERE movement_id = ?`
        )
        .get(movementId) as { confirmed_on: string; confirmed_source: string };
      expect(row).toMatchObject({ confirmed_on: "2099-06-15", confirmed_source: "cartola" });
    } finally {
      db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month = ?`).run(
        accountId,
        periodMonth
      );
    }
  });
});
