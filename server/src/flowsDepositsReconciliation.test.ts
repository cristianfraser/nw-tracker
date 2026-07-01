import { afterEach, describe, expect, it } from "vitest";
import {
  buildDepositsReconciliationPayload,
  resolveInternalNetWorthTransfers,
  type DepositReconciliationRow,
  type DepositRedemptionRow,
} from "./flowsDepositsReconciliation.js";
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
      } else if (pureFamilyAhorro.has(row.movement_id)) {
        // Family (split self=0 or forensic funding=family) outranks synthetic mirrors.
        expect(row.status).toBe("resolved_family_funded");
      } else if (linkSource === "synthetic") {
        expect(["linked_synthetic", "resolved_family_funded"]).toContain(row.status);
      } else {
        const month = monthKeyFromYmd(row.occurred_on);
        const expected =
          month != null && checkingMonths.has(month)
            ? "unlinked_checking_present"
            : "unlinked_no_checking_source";
        // An otherwise-unlinked row may instead be netted out as an internal net-worth transfer.
        expect([expected, "resolved_internal_transfer"]).toContain(row.status);
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
      resolved_internal_transfer: 0,
      unlinked_no_checking_source: 0,
      unlinked_checking_present: 0,
    };
    const counts = {
      linked: 0,
      linked_synthetic: 0,
      resolved_family_funded: 0,
      resolved_internal_transfer: 0,
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
    const monthInternal = payload.by_month.reduce((s, m) => s + m.resolved_internal_transfer_clp, 0);
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
    expect(monthInternal).toBe(payload.by_status.resolved_internal_transfer.total_clp);
    expect(monthNoChecking).toBe(payload.by_status.unlinked_no_checking_source.total_clp);
    expect(monthChecking).toBe(payload.by_status.unlinked_checking_present.total_clp);
    for (const m of payload.by_month) {
      expect(m.total_clp).toBe(
        m.linked_clp +
          m.linked_synthetic_clp +
          m.resolved_family_funded_clp +
          m.resolved_internal_transfer_clp +
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

  describe("manual transfer rows (from → to)", () => {
    afterEach(() => {
      db.prepare(`DELETE FROM movements WHERE note = 'vitest-internal-transfer-row'`).run();
    });

    it("resolves the from-leg of a net-worth → net-worth transfer by construction", () => {
      // Two plain non-checking net-worth accounts (no Buda buffer / equity-MTM special-casing).
      const fromAcc = db
        .prepare(
          `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
           WHERE g.slug LIKE '%fondo_reserva%' LIMIT 1`
        )
        .get() as { id: number } | undefined;
      const toAcc = db
        .prepare(
          `SELECT a.id FROM accounts a JOIN asset_groups g ON g.id = a.asset_group_id
           WHERE g.slug LIKE '%fintual_risky_norris%' AND a.id != ? LIMIT 1`
        )
        .get(fromAcc?.id ?? -1) as { id: number } | undefined;
      if (!fromAcc || !toAcc) return;

      db.prepare(
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
         VALUES (NULL, ?, ?, ?, ?, 'vitest-internal-transfer-row')`
      ).run(fromAcc.id, toAcc.id, 7_777_333, "2025-06-16");

      const after = buildDepositsReconciliationPayload();
      const leg = after.redemptions.find(
        (r) => r.account_id === fromAcc.id && Math.round(r.amount_clp) === 7_777_333
      );
      expect(leg?.status).toBe("resolved_internal_transfer");
    });
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
      const sums = { linked: 0, resolved_internal_transfer: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
      const counts = { linked: 0, resolved_internal_transfer: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
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

  describe("internal net-worth transfers", () => {
    const dep = (
      account_id: number,
      occurred_on: string,
      amount_clp: number,
      status: DepositReconciliationRow["status"] = "unlinked_checking_present"
    ): DepositReconciliationRow => ({
      movement_id: account_id * 1000 + Math.round(amount_clp / 1000),
      occurred_on,
      account_id,
      account_name: `acct${account_id}`,
      category: "brokerage",
      amount_clp,
      amount_usd: null,
      status,
    });
    const red = (
      account_id: number,
      occurred_on: string,
      amount_clp: number,
      status: DepositRedemptionRow["status"] = "unlinked_checking_present"
    ): DepositRedemptionRow => ({
      occurred_on,
      account_id,
      account_name: `acct${account_id}`,
      category: "brokerage",
      amount_clp,
      amount_usd: null,
      status,
    });

    it("pairs an unlinked deposit with a same-amount unlinked redemption in another account", () => {
      const rows = [dep(44, "2025-02-11", 10_000_000)];
      const redemptions = [red(45, "2025-02-10", 10_000_000)];
      resolveInternalNetWorthTransfers(rows, redemptions);
      expect(rows[0]!.status).toBe("resolved_internal_transfer");
      expect(redemptions[0]!.status).toBe("resolved_internal_transfer");
    });

    it("does not pair across a too-large date gap, different amounts, or the same account", () => {
      const rows = [
        dep(44, "2025-02-01", 5_000_000), // 10-day gap
        dep(44, "2025-03-01", 7_000_000), // amount mismatch
        dep(44, "2025-04-01", 3_000_000), // same account as its redemption
      ];
      const redemptions = [
        red(45, "2025-02-15", 5_000_000),
        red(45, "2025-03-01", 6_000_000),
        red(44, "2025-04-01", 3_000_000),
      ];
      resolveInternalNetWorthTransfers(rows, redemptions);
      expect(rows.every((r) => r.status === "unlinked_checking_present")).toBe(true);
      expect(redemptions.every((r) => r.status === "unlinked_checking_present")).toBe(true);
    });

    it("never touches already-linked legs and pairs same-amount peers 1:1 (closest gap first)", () => {
      const rows = [
        dep(44, "2025-02-11", 3_000_000), // 1d from the 02-10 redemption
        dep(44, "2025-02-20", 3_000_000, "linked"), // already linked — must stay
      ];
      const redemptions = [
        red(45, "2025-02-10", 3_000_000),
        red(46, "2025-02-16", 3_000_000), // 5d — no unlinked deposit left to pair
      ];
      resolveInternalNetWorthTransfers(rows, redemptions);
      expect(rows[0]!.status).toBe("resolved_internal_transfer");
      expect(rows[1]!.status).toBe("linked");
      expect(redemptions[0]!.status).toBe("resolved_internal_transfer");
      expect(redemptions[1]!.status).toBe("unlinked_checking_present");
    });
  });
});
