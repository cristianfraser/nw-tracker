import { afterEach, describe, expect, it } from "vitest";
import { buildDepositsReconciliationPayload } from "./flowsDepositsReconciliation.js";
import { loadBestLinkSourceByMovementId } from "./expenseDepositLinks.js";
import { buildFlowsCreditCardExpensesPayload } from "./flowsCreditCardExpenses.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { loadPureFamilyAhorroDepositMovementIds } from "./cuentaAhorroDepositSplits.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";

describe("buildDepositsReconciliationPayload", () => {
  it("classifies every row into exactly one status consistent with the link table", () => {
    const payload = buildDepositsReconciliationPayload();
    const linkSourceByMovementId = loadBestLinkSourceByMovementId();
    const pureFamilyAhorro = loadPureFamilyAhorroDepositMovementIds();

    // Coverage is decided by cuenta_corriente specifically (see
    // loadCuentaCorrienteMonthsWithData in flowsDepositsReconciliation.ts) — cuenta_vista having
    // data for a month does not mean cuenta_corriente does, so it must not be unioned in here.
    const checkingMonths = new Set<string>();
    for (const accountId of listMovementBalanceCashAccountIds()) {
      if (accountKindSlugForAccountId(accountId) !== "cuenta_corriente") continue;
      const resp = getCheckingCartolaMonths(accountId);
      if (!resp) continue;
      for (const m of resp.imported_months) checkingMonths.add(m);
    }

    for (const row of payload.rows) {
      const linkSource = linkSourceByMovementId.get(row.movement_id);
      if (linkSource === "auto" || linkSource === "manual") {
        expect(row.status).toBe("linked");
      } else if (linkSource === "synthetic") {
        expect(row.status).toBe("linked_synthetic");
      } else if (pureFamilyAhorro.has(row.movement_id)) {
        expect(row.status).toBe("resolved_family_funded");
      } else {
        const month = monthKeyFromYmd(row.occurred_on);
        const expected =
          month != null && checkingMonths.has(month)
            ? "unlinked_checking_present"
            : "unlinked_no_checking_source";
        expect(row.status).toBe(expected);
      }
      expect(row.amount_clp).toBeGreaterThan(0);
    }
  });

  it("by_status totals match the sum of classified rows", () => {
    const payload = buildDepositsReconciliationPayload();
    const sums = {
      linked: 0,
      linked_synthetic: 0,
      resolved_family_funded: 0,
      unlinked_no_checking_source: 0,
      unlinked_checking_present: 0,
    };
    const counts = {
      linked: 0,
      linked_synthetic: 0,
      resolved_family_funded: 0,
      unlinked_no_checking_source: 0,
      unlinked_checking_present: 0,
    };
    for (const row of payload.rows) {
      sums[row.status] += row.amount_clp;
      counts[row.status] += 1;
    }
    for (const status of Object.keys(sums) as (keyof typeof sums)[]) {
      expect(payload.by_status[status].total_clp).toBe(sums[status]);
      expect(payload.by_status[status].count).toBe(counts[status]);
    }
  });

  it("by_month rows sum to the same totals as by_status across all rows", () => {
    const payload = buildDepositsReconciliationPayload();
    const monthLinked = payload.by_month.reduce((s, m) => s + m.linked_clp, 0);
    const monthLinkedSynthetic = payload.by_month.reduce((s, m) => s + m.linked_synthetic_clp, 0);
    const monthFamily = payload.by_month.reduce((s, m) => s + m.resolved_family_funded_clp, 0);
    const monthNoChecking = payload.by_month.reduce(
      (s, m) => s + m.unlinked_no_checking_source_clp,
      0
    );
    const monthChecking = payload.by_month.reduce(
      (s, m) => s + m.unlinked_checking_present_clp,
      0
    );
    expect(monthLinked).toBe(payload.by_status.linked.total_clp);
    expect(monthLinkedSynthetic).toBe(payload.by_status.linked_synthetic.total_clp);
    expect(monthFamily).toBe(payload.by_status.resolved_family_funded.total_clp);
    expect(monthNoChecking).toBe(payload.by_status.unlinked_no_checking_source.total_clp);
    expect(monthChecking).toBe(payload.by_status.unlinked_checking_present.total_clp);
    for (const m of payload.by_month) {
      expect(m.total_clp).toBe(
        m.linked_clp +
          m.linked_synthetic_clp +
          m.resolved_family_funded_clp +
          m.unlinked_no_checking_source_clp +
          m.unlinked_checking_present_clp
      );
    }
  });

  it("excludes AFP and AFC payroll inflows from every row", () => {
    const payload = buildDepositsReconciliationPayload();
    const afpAfcAccount = payload.rows.find(
      (r) => r.account_name === "AFP" || r.account_name === "AFC"
    );
    expect(afpAfcAccount).toBeUndefined();
  });

  describe("synthetic checking-gap mirrors", () => {
    afterEach(() => {
      db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE note = ?`).run(
        "vitest-fixture-mirror"
      );
      db.prepare(`DELETE FROM expense_deposit_links WHERE link_source = 'synthetic'`).run();
    });

    it("classifies a mirrored unlinked_no_checking_source deposit as linked_synthetic", () => {
      const before = buildDepositsReconciliationPayload();
      const candidate = before.rows.find((r) => r.status === "unlinked_no_checking_source");
      if (!candidate) return;

      const corrienteAccount = db
        .prepare(
          `SELECT a.id FROM accounts a
           JOIN asset_groups g ON g.id = a.asset_group_id
           WHERE g.slug LIKE '%cuenta_corriente%' LIMIT 1`
        )
        .get() as { id: number } | undefined;
      if (!corrienteAccount) return;

      db.prepare(
        `INSERT INTO checking_gap_deposit_mirrors (account_id, deposit_movement_id, amount_clp, occurred_on, note)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        corrienteAccount.id,
        candidate.movement_id,
        candidate.amount_clp,
        candidate.occurred_on,
        "vitest-fixture-mirror"
      );

      buildFlowsCreditCardExpensesPayload();

      const after = buildDepositsReconciliationPayload();
      const row = after.rows.find((r) => r.movement_id === candidate.movement_id);
      expect(row?.status).toBe("linked_synthetic");
    });
  });

  describe("negative deposits (redemptions)", () => {
    it("every redemption classifies into exactly one status with a positive amount", () => {
      const payload = buildDepositsReconciliationPayload();
      const sums = { linked: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
      const counts = { linked: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
      for (const r of payload.redemptions) {
        expect(r.amount_clp).toBeGreaterThan(0);
        sums[r.status] += r.amount_clp;
        counts[r.status] += 1;
      }
      for (const status of Object.keys(sums) as (keyof typeof sums)[]) {
        expect(payload.redemptions_by_status[status].total_clp).toBe(sums[status]);
        expect(payload.redemptions_by_status[status].count).toBe(counts[status]);
      }
    });

    it("does not classify any checking-bucket account as a redemption target", () => {
      const payload = buildDepositsReconciliationPayload();
      for (const r of payload.redemptions) {
        expect(accountKindSlugForAccountId(r.account_id)).not.toBe("cuenta_corriente");
        expect(accountKindSlugForAccountId(r.account_id)).not.toBe("cuenta_vista");
      }
    });
  });

  describe("cuenta_ahorro deposit splits", () => {
    function findAhorroDeposit(): { movement_id: number; amount_clp: number } | null {
      const rows = buildDepositsReconciliationPayload().rows;
      for (const r of rows) {
        if (accountKindSlugForAccountId(r.account_id) === "cuenta_ahorro_vivienda") {
          return { movement_id: r.movement_id, amount_clp: r.amount_clp };
        }
      }
      return null;
    }

    afterEach(() => {
      db.prepare(`DELETE FROM cuenta_ahorro_deposit_splits WHERE note = ?`).run("vitest-fixture-split");
      db.prepare(`DELETE FROM checking_gap_deposit_mirrors WHERE note = ?`).run("ahorro-split|self_funded");
      db.prepare(`DELETE FROM expense_deposit_links WHERE link_source = 'synthetic'`).run();
      buildFlowsCreditCardExpensesPayload();
    });

    it("marks a self-funded split as linked_synthetic and a pure-family split as resolved_family_funded", async () => {
      const deposit = findAhorroDeposit();
      if (!deposit) return;
      const { upsertCuentaAhorroDepositSplit } = await import("./cuentaAhorroDepositSplits.js");

      // Self-funded portion → partial mirror → linked_synthetic.
      upsertCuentaAhorroDepositSplit(deposit.movement_id, Math.round(deposit.amount_clp / 2), "vitest-fixture-split");
      buildFlowsCreditCardExpensesPayload();
      let row = buildDepositsReconciliationPayload().rows.find((r) => r.movement_id === deposit.movement_id);
      expect(row?.status).toBe("linked_synthetic");

      // Pure-family (self = 0) → no mirror → resolved_family_funded.
      upsertCuentaAhorroDepositSplit(deposit.movement_id, 0, "vitest-fixture-split");
      buildFlowsCreditCardExpensesPayload();
      row = buildDepositsReconciliationPayload().rows.find((r) => r.movement_id === deposit.movement_id);
      expect(row?.status).toBe("resolved_family_funded");
    });

    it("rejects a self_funded_clp greater than the deposit amount", async () => {
      const deposit = findAhorroDeposit();
      if (!deposit) return;
      const { upsertCuentaAhorroDepositSplit } = await import("./cuentaAhorroDepositSplits.js");
      expect(() =>
        upsertCuentaAhorroDepositSplit(deposit.movement_id, deposit.amount_clp + 1, "vitest-fixture-split")
      ).toThrow(/out of range/);
    });
  });
});
