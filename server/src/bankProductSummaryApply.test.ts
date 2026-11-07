import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BankProductSummaryPayload } from "nw-tracker-contracts";
import { db } from "./db.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { seedNavTree } from "./seedNavTree.js";
import { applyBankProductSummary } from "./bankProductSummaryApply.js";
import { runIngestTask } from "./ingestTasks.js";

const NUMBER = "005199990177";
const REFS = ["vitest-summary-a", "vitest-summary-b", "vitest-summary-c", "vitest-summary-d"];
const DIFFERS = "Bank balance differs from the app";
let accountId = 0;
let messageFloor = 0;

function summary(balance: number, observedAt: string): BankProductSummaryPayload {
  return {
    issuer: "santander",
    observed_at: observedAt,
    cards: { status: "unavailable", reason: "vitest: no card rows" },
    accounts: [
      { number: NUMBER, product: "checking", currency: "usd", balance, label: "CTA CORRIENTE MX", status: "ACTIVA" },
    ],
  };
}

function differsNotifications(): number {
  return (
    db
      .prepare(`SELECT COUNT(*) AS n FROM app_messages WHERE id > ? AND kind = 'notification' AND title = ?`)
      .get(messageFloor, DIFFERS) as { n: number }
  ).n;
}

function cleanup(): void {
  const marks = REFS.map(() => "?").join(", ");
  db.prepare(`DELETE FROM bank_account_balance_snapshots WHERE source_ref IN (${marks})`).run(...REFS);
  db.prepare(`DELETE FROM cc_bank_cupo_captures WHERE source_file IN (${marks})`).run(...REFS);
  db.prepare(`DELETE FROM app_messages WHERE id > ?`).run(messageFloor);
  if (accountId) {
    db.prepare(`DELETE FROM bank_account_numbers WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM portfolio_group_items WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM account_sync_sources WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    db.prepare(`DELETE FROM asset_groups WHERE slug LIKE '%vitest_summary_usd__usd'`).run();
    seedNavTree();
  }
}

describe("bank product summary (hourly balance poll)", () => {
  beforeAll(() => {
    messageFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM app_messages`).get() as { m: number }).m;
    accountId = createPanelAccount({
      account: {
        account_type: "usd_cash",
        name: "Vitest Summary USD",
        bucket_slug: "cash_savings",
        category_slug: "vitest_summary_usd",
        exclude_from_group_totals: false,
      },
    }).account_id;
    db.prepare(`INSERT INTO bank_account_numbers (account_id, issuer, number, currency) VALUES (?, 'santander', ?, 'usd')`).run(
      accountId,
      NUMBER
    );
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (?, 100, 'usd', '2020-01-02', 'vitest-summary', 'savings_earnings')`
    ).run(accountId);
  });

  afterAll(cleanup);

  it("reads only the listings of the products that disagree", () => {
    const agrees = applyBankProductSummary(summary(100, "2020-01-05T02:00:00.000Z"), REFS[0]!);
    // No card rows stated: the card feed is read to find out.
    expect(agrees.fetch).toEqual(["card-movements"]);
    expect(agrees.mismatches.some((m) => m.includes("Vitest Summary USD"))).toBe(false);

    const differs = applyBankProductSummary(summary(110, "2020-01-06T02:00:00.000Z"), REFS[1]!);
    expect(differs.fetch).toEqual(["card-movements", "checking-usd-movements"]);
    expect(differs.mismatches.find((m) => m.includes("Vitest Summary USD"))).toContain("app − bank -10");
  });

  it("notifies a difference that stays after the listing was read, once per difference", () => {
    runIngestTask("cc_bank_cupo_check", { dry_run: false, recheck: true });
    expect(differsNotifications()).toBe(1);
    // The next hour, the same difference: no new notification.
    applyBankProductSummary(summary(110, "2020-01-06T03:00:00.000Z"), REFS[2]!);
    runIngestTask("cc_bank_cupo_check", { dry_run: false, recheck: true });
    expect(differsNotifications()).toBe(1);
    // Another amount is another difference.
    applyBankProductSummary(summary(115, "2020-01-06T04:00:00.000Z"), REFS[3]!);
    runIngestTask("cc_bank_cupo_check", { dry_run: false, recheck: true });
    expect(differsNotifications()).toBe(2);
  });
});
