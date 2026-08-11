import { describe, expect, it } from "vitest";
import {
  checkingMovementBalanceAtMonthEnd,
  clearCheckingBalanceCache,
} from "./checkingCartolaBalances.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { monthEndUtcYmd } from "./calendarMonth.js";
import { db } from "./db.js";

function createSyntheticVistaAccount(name: string): number {
  const bucket = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'cash_eqs__cuenta_vista' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!bucket) throw new Error("cuenta_vista asset group not found");
  return Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, 'vitest:cartola-months')`
      )
      .run(bucket.id, name).lastInsertRowid
  );
}

function destroySyntheticVistaAccount(accountId: number): void {
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ?`).run(accountId);
  db.prepare(
    `DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`
  ).run(accountId, accountId, accountId);
  db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  clearCheckingBalanceCache(accountId);
}

describe("getCheckingCartolaMonths", () => {
  it("returns rows for cuenta corriente account with imports", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const payload = getCheckingCartolaMonths(row.id);
    expect(payload).not.toBeNull();
    expect(payload!.rows.length).toBeGreaterThan(0);
    const apr = payload!.rows.find((r) => r.period_month === "2026-04");
    expect(apr?.has_cartola).toBe(true);
    expect(apr?.balance_end_clp).toBe(checkingMovementBalanceAtMonthEnd(row.id, "2026-04"));
    expect(apr!.deposits_clp).toBeGreaterThan(0);
    expect(apr!.withdrawals_clp).toBeGreaterThan(0);
    const months = payload!.rows.map((r) => r.period_month);
    if (months.includes("2020-05") && months.includes("2020-07")) {
      expect(months).toContain("2020-06");
    }
  });

  // Regression (2026-08-11): abonos/cargos summed `WHERE account_id = ?` over
  // `note LIKE 'import:cartola|<month>|%'` rows only — transfer legs (account_id NULL)
  // and rows with non-cartola notes (mirror-converted transfers, daily-xlsx partials,
  // manual movements) were invisible, so a month whose only activity was transfers read
  // abonos 0 / cargos 0 (real case: cuenta vista 2026-06, a 5.000 mirror-pair round trip).
  it("counts transfer legs and non-cartola-note rows; months without cartola still total", () => {
    const accountId = createSyntheticVistaAccount("Vitest · cartola months fixture");
    const counterpartId = createSyntheticVistaAccount("Vitest · cartola months counterpart");
    try {
      db.prepare(
        `INSERT INTO checking_cartola_imports (
           account_id, period_month, source_file, movement_count,
           saldo_final_clp, saldo_inicial_clp, period_from, period_to
         ) VALUES (?, '2099-01', 'vitest-2099-01.pdf', 4, 23000, 0, '2099-01-01', '2099-01-31')`
      ).run(accountId);

      // Cartola-note single leg, +50.000.
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, 50000, 'clp', '2099-01-15', 'import:cartola|2099-01|1|abono')`
      ).run(accountId);
      // Outbound transfer leg (account_id NULL), −30.000.
      db.prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
         VALUES (?, ?, 30000, 'clp', '2099-01-20', 'Traspaso espejo (vitest)')`
      ).run(accountId, counterpartId);
      // Inbound transfer leg, +5.000.
      db.prepare(
        `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
         VALUES (?, ?, 5000, 'clp', '2099-01-22', 'Traspaso espejo (vitest)')`
      ).run(counterpartId, accountId);
      // Manual single leg with a human note, −2.000.
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, -2000, 'clp', '2099-01-25', 'vitest manual')`
      ).run(accountId);
      // Next month has NO cartola import — a daily-xlsx partial row, −7.000.
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, -7000, 'clp', '2099-02-03', 'import:cartola-partial|2099-02-03|-7000|Giro')`
      ).run(accountId);
      clearCheckingBalanceCache(accountId);

      const payload = getCheckingCartolaMonths(accountId);
      expect(payload).not.toBeNull();

      const jan = payload!.rows.find((r) => r.period_month === "2099-01");
      expect(jan?.has_cartola).toBe(true);
      expect(jan?.deposits_clp).toBe(55000);
      expect(jan?.withdrawals_clp).toBe(32000);
      expect(jan?.movement_count).toBe(4);

      const feb = payload!.rows.find((r) => r.period_month === "2099-02");
      expect(feb?.has_cartola).toBe(false);
      expect(feb?.deposits_clp).toBe(0);
      expect(feb?.withdrawals_clp).toBe(7000);
      expect(feb?.movement_count).toBe(1);

      // Same accounting as the balance walk: month delta ≡ abonos − cargos.
      for (const row of [jan!, feb!]) {
        const priorYm =
          row.period_month === "2099-01" ? "2098-12" : "2099-01";
        const delta =
          checkingMovementBalanceAtMonthEnd(accountId, row.period_month) -
          checkingMovementBalanceAtMonthEnd(accountId, priorYm);
        expect(delta).toBe(row.deposits_clp - row.withdrawals_clp);
        expect(row.balance_end_clp).toBe(
          checkingMovementBalanceAtMonthEnd(accountId, row.period_month)
        );
        expect(row.as_of_date).toBe(monthEndUtcYmd(row.period_month));
      }
    } finally {
      destroySyntheticVistaAccount(accountId);
      destroySyntheticVistaAccount(counterpartId);
    }
  });

  it("returns null for non-checking accounts", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'fondo_reserva' OR g.slug LIKE '%__fondo_reserva' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    expect(getCheckingCartolaMonths(row.id)).toBeNull();
  });
});
