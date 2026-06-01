import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { monthEndUtcYmd } from "./calendarMonth.js";
import { cartolaCashAccountIdOptional } from "./movementBalanceCashAccounts.js";
import {
  checkingLedgerAnchorNote,
  checkingMovementBalanceClpAt,
  checkingMovementBalanceClpAtCached,
  clearCheckingAccountValuations,
  clearCheckingBalanceCache,
  clearCheckingLedgerAnchor,
  defaultCheckingLedgerAnchorDate,
  ensureCheckingLedgerAnchor,
  getCheckingLedgerAnchor,
  upsertCheckingLedgerAnchor,
} from "./checkingCartolaBalances.js";

const TEST_MONTH_EARLY = "2099-01";
const TEST_MONTH_LATE = "2099-02";
const TEST_DEFAULT_ANCHOR_DATE = defaultCheckingLedgerAnchorDate(TEST_MONTH_EARLY);

function cleanupAnchorFixture(accountId: number): void {
  db.prepare(`DELETE FROM checking_cartola_imports WHERE account_id = ? AND period_month IN (?, ?)`).run(
    accountId,
    TEST_MONTH_EARLY,
    TEST_MONTH_LATE
  );
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
    accountId,
    "import:cartola|2099-0%"
  );
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND note LIKE ?`).run(
    accountId,
    "import:cartola|opening|%"
  );
  db.prepare(`DELETE FROM movements WHERE account_id = ? AND note = ?`).run(accountId, "manual gap-fill");
  clearCheckingBalanceCache(accountId);
}

function seedCartolaImport(
  accountId: number,
  periodMonth: string,
  saldoFinal: number,
  saldoInicial: number | null = null
): void {
  db.prepare(
    `INSERT INTO checking_cartola_imports (
       account_id, period_month, source_file, movement_count,
       saldo_final_clp, saldo_inicial_clp, period_from, period_to
     ) VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
  ).run(
    accountId,
    periodMonth,
    `vitest-${periodMonth}.pdf`,
    saldoFinal,
    saldoInicial,
    `${periodMonth}-01`,
    monthEndUtcYmd(periodMonth)
  );
}

describe("checkingCartolaBalances", () => {
  it("computes balance as movement cumsum", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;

    const last = db
      .prepare(
        `SELECT occurred_on FROM movements WHERE account_id = ?
         ORDER BY occurred_on DESC, id DESC LIMIT 1`
      )
      .get(row.id) as { occurred_on: string } | undefined;
    if (!last) return;

    const sqlSum = db
      .prepare(
        `SELECT COALESCE(SUM(amount_clp), 0) AS t FROM movements
         WHERE account_id = ? AND occurred_on <= ?`
      )
      .get(row.id, last.occurred_on) as { t: number };
    expect(checkingMovementBalanceClpAt(row.id, last.occurred_on)).toBe(Math.round(Number(sqlSum.t)));
  });

  it("cache returns same value until cleared", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const last = db
      .prepare(`SELECT occurred_on FROM movements WHERE account_id = ? ORDER BY occurred_on DESC LIMIT 1`)
      .get(row.id) as { occurred_on: string } | undefined;
    if (!last) return;

    clearCheckingBalanceCache(row.id);
    const a = checkingMovementBalanceClpAtCached(row.id, last.occurred_on);
    const b = checkingMovementBalanceClpAtCached(row.id, last.occurred_on);
    expect(a).toBe(b);
  });

  it("clearCheckingAccountValuations removes persisted rows", () => {
    const row = db
      .prepare(
        `SELECT a.id FROM accounts a
         JOIN asset_groups g ON g.id = a.asset_group_id
         WHERE g.slug = 'cuenta_corriente' OR g.slug LIKE '%__cuenta_corriente' LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!row) return;
    const cleared = clearCheckingAccountValuations(row.id);
    expect(cleared).toBeGreaterThanOrEqual(0);
    const left = db
      .prepare(`SELECT COUNT(*) AS c FROM valuations WHERE account_id = ?`)
      .get(row.id) as { c: number };
    expect(left.c).toBe(0);
  });

  describe("ledger anchor", () => {
    it("uses latest cartola saldo final and removes legacy opening rows", () => {
      const accountId = cartolaCashAccountIdOptional("cuenta_vista");
      if (accountId == null) return;

      cleanupAnchorFixture(accountId);
      seedCartolaImport(accountId, TEST_MONTH_EARLY, 500, 1000);
      seedCartolaImport(accountId, TEST_MONTH_LATE, 900, 500);

      db.prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, -100, ?, ?, NULL)`
      ).run(
        accountId,
        `${TEST_MONTH_LATE}-10`,
        `import:cartola|${TEST_MONTH_LATE}|401|Test|on:${TEST_MONTH_LATE}-10|amt:-100|idx:0`
      );

      db.prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, 811098, '2017-07-31', 'import:cartola|opening|2017-07|saldo inicial', NULL)`
      ).run(accountId);

      const anchor = ensureCheckingLedgerAnchor(accountId);
      expect(anchor.inserted || anchor.updated).toBe(true);
      expect(anchor.anchor_period_month).toBe(TEST_MONTH_LATE);
      expect(anchor.amount_clp).toBe(1000);
      expect(anchor.occurred_on).toBe(TEST_DEFAULT_ANCHOR_DATE);

      const openingLeft = db
        .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note LIKE ?`)
        .get(accountId, "import:cartola|opening|%") as { c: number };
      expect(openingLeft.c).toBe(0);

      const balanceAtAnchor = checkingMovementBalanceClpAt(
        accountId,
        monthEndUtcYmd(TEST_MONTH_LATE)
      );
      expect(balanceAtAnchor).toBe(900);

      cleanupAnchorFixture(accountId);
    });

    it("recomputes anchor amount when a manual gap-fill movement is added", () => {
      const accountId = cartolaCashAccountIdOptional("cuenta_vista");
      if (accountId == null) return;

      cleanupAnchorFixture(accountId);
      seedCartolaImport(accountId, TEST_MONTH_EARLY, 500);
      seedCartolaImport(accountId, TEST_MONTH_LATE, 900);

      ensureCheckingLedgerAnchor(accountId);
      const before = getCheckingLedgerAnchor(accountId);
      expect(before?.amount_clp).toBe(900);

      db.prepare(
        `INSERT INTO movements (account_id, amount_clp, occurred_on, note, units_delta)
         VALUES (?, 50, ?, 'manual gap-fill', NULL)`
      ).run(accountId, `${TEST_MONTH_LATE}-15`);

      const resync = ensureCheckingLedgerAnchor(accountId);
      expect(resync.updated).toBe(true);
      expect(resync.amount_clp).toBe(850);

      const balanceAtAnchor = checkingMovementBalanceClpAt(
        accountId,
        monthEndUtcYmd(TEST_MONTH_LATE)
      );
      expect(balanceAtAnchor).toBe(900);

      cleanupAnchorFixture(accountId);
    });

    it("auto-sync overwrites manual UI anchor amount and date", () => {
      const accountId = cartolaCashAccountIdOptional("cuenta_vista");
      if (accountId == null) return;

      cleanupAnchorFixture(accountId);
      seedCartolaImport(accountId, TEST_MONTH_EARLY, 500);
      seedCartolaImport(accountId, TEST_MONTH_LATE, 900);
      ensureCheckingLedgerAnchor(accountId);

      upsertCheckingLedgerAnchor(accountId, { amount_clp: 123, occurred_on: `${TEST_MONTH_LATE}-20` });
      const manual = getCheckingLedgerAnchor(accountId);
      expect(manual?.amount_clp).toBe(123);
      expect(manual?.occurred_on).toBe(`${TEST_MONTH_LATE}-20`);

      const resync = ensureCheckingLedgerAnchor(accountId);
      expect(resync.updated).toBe(true);
      expect(resync.amount_clp).toBe(900);
      expect(resync.occurred_on).toBe(TEST_DEFAULT_ANCHOR_DATE);

      cleanupAnchorFixture(accountId);
    });

    it("clearCheckingLedgerAnchor removes the anchor movement", () => {
      const accountId = cartolaCashAccountIdOptional("cuenta_vista");
      if (accountId == null) return;

      cleanupAnchorFixture(accountId);
      seedCartolaImport(accountId, TEST_MONTH_EARLY, 500);
      seedCartolaImport(accountId, TEST_MONTH_LATE, 900);
      ensureCheckingLedgerAnchor(accountId);

      expect(clearCheckingLedgerAnchor(accountId)).toBe(true);
      expect(getCheckingLedgerAnchor(accountId)).toBeNull();

      const note = checkingLedgerAnchorNote(TEST_MONTH_LATE);
      const left = db
        .prepare(`SELECT COUNT(*) AS c FROM movements WHERE account_id = ? AND note = ?`)
        .get(accountId, note) as { c: number };
      expect(left.c).toBe(0);

      cleanupAnchorFixture(accountId);
    });
  });
});
