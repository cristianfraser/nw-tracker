import { afterEach, describe, expect, it } from "vitest";
import {
  buildDepositsReconciliationPayload,
  resolveInternalNetWorthTransfers,
  type DepositReconciliationRow,
  type DepositRedemptionRow,
} from "./flowsDepositsReconciliation.js";
import { loadBestLinkSourceByMovementId } from "./expenseDepositLinks.js";
import { getCheckingCartolaMonths } from "./checkingCartolaMonthSummary.js";
import { listMovementBalanceCashAccountIds } from "./movementBalanceCashAccounts.js";
import { accountKindSlugForAccountId } from "./accountBucket.js";
import { monthKeyFromYmd } from "./calendarMonth.js";
import { db } from "./db.js";

describe("buildDepositsReconciliationPayload", () => {
  it("classifies every row into exactly one status consistent with the link table", () => {
    const payload = buildDepositsReconciliationPayload("clp");
    const linkSourceByMovementId = loadBestLinkSourceByMovementId();

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
      } else {
        const month = monthKeyFromYmd(row.occurred_on);
        const expected =
          month != null && checkingMonths.has(month)
            ? "unlinked_checking_present"
            : "unlinked_no_checking_source";
        // An otherwise-unlinked row may instead be netted out as an internal net-worth transfer.
        expect([expected, "resolved_internal_transfer"]).toContain(row.status);
      }
      expect(row.amount!).toBeGreaterThan(0);
    }
  });

  it("by_status totals match the sum of classified rows", () => {
    const payload = buildDepositsReconciliationPayload("clp");
    const sums = {
      linked: 0,
      resolved_tax_refund: 0,
      resolved_internal_transfer: 0,
      unlinked_no_checking_source: 0,
      unlinked_checking_present: 0,
    };
    const counts = {
      linked: 0,
      resolved_tax_refund: 0,
      resolved_internal_transfer: 0,
      unlinked_no_checking_source: 0,
      unlinked_checking_present: 0,
    };
    for (const row of payload.rows) {
      sums[row.status] += row.amount!;
      counts[row.status] += 1;
    }
    for (const status of Object.keys(sums) as (keyof typeof sums)[]) {
      expect(payload.by_status[status].total).toBe(sums[status]);
      expect(payload.by_status[status].count).toBe(counts[status]);
    }
  });

  it("by_month rows sum to the same totals as by_status across all rows", () => {
    const payload = buildDepositsReconciliationPayload("clp");
    const monthLinked = payload.by_month.reduce((s, m) => s + m.linked!, 0);
    const monthInternal = payload.by_month.reduce((s, m) => s + m.resolved_internal_transfer!, 0);
    const monthNoChecking = payload.by_month.reduce(
      (s, m) => s + m.unlinked_no_checking_source!,
      0
    );
    const monthChecking = payload.by_month.reduce(
      (s, m) => s + m.unlinked_checking_present!,
      0
    );
    expect(monthLinked).toBe(payload.by_status.linked.total);
    expect(monthInternal).toBe(payload.by_status.resolved_internal_transfer.total);
    expect(monthNoChecking).toBe(payload.by_status.unlinked_no_checking_source.total);
    expect(monthChecking).toBe(payload.by_status.unlinked_checking_present.total);
    for (const m of payload.by_month) {
      expect(m.total).toBe(
        m.linked! +
          m.resolved_internal_transfer! +
          m.unlinked_no_checking_source! +
          m.unlinked_checking_present!
      );
    }
  });

  it("excludes AFP and AFC payroll inflows from every row", () => {
    const payload = buildDepositsReconciliationPayload("clp");
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
        `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note)
         VALUES (NULL, ?, ?, ?, 'clp', ?, 'vitest-internal-transfer-row')`
      ).run(fromAcc.id, toAcc.id, 7_777_333, "2025-06-16");

      const after = buildDepositsReconciliationPayload("clp");
      const leg = after.redemptions.find(
        (r) => r.account_id === fromAcc.id && Math.round(r.amount!) === 7_777_333
      );
      expect(leg?.status).toBe("resolved_internal_transfer");
    });
  });

  describe("negative deposits (redemptions)", () => {
    it("every redemption classifies into exactly one status with a positive amount", () => {
      const payload = buildDepositsReconciliationPayload("clp");
      const sums = { linked: 0, resolved_internal_transfer: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
      const counts = { linked: 0, resolved_internal_transfer: 0, unlinked_no_checking_source: 0, unlinked_checking_present: 0 };
      for (const r of payload.redemptions) {
        expect(r.amount!).toBeGreaterThan(0);
        sums[r.status] += r.amount!;
        counts[r.status] += 1;
      }
      for (const status of Object.keys(sums) as (keyof typeof sums)[]) {
        expect(payload.redemptions_by_status[status].total).toBe(sums[status]);
        expect(payload.redemptions_by_status[status].count).toBe(counts[status]);
      }
    });

    it("does not classify any checking-bucket account as a redemption target", () => {
      const payload = buildDepositsReconciliationPayload("clp");
      for (const r of payload.redemptions) {
        expect(accountKindSlugForAccountId(r.account_id)).not.toBe("cuenta_corriente");
        expect(accountKindSlugForAccountId(r.account_id)).not.toBe("cuenta_vista");
      }
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
