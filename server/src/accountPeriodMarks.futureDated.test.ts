import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { monthEndCloseClpForAccount } from "./accountPeriodMarks.js";
import { loadAccountRowsForGroupConsolidation } from "./groupMonthlyPerfConsolidation.js";

const FIXTURE = "vitest-future-dated-clp-cash";

/**
 * Current-month closings are marked as of Chile-today, not the future month-end — and "today"
 * has no upper bound (`displayLedgerCutoffYmd`, 2026-09-06): a movement dated later in the
 * month (a stock_buy settling tomorrow, a bank posting an after-cutoff wire on Monday) already
 * counts, and keeps counting once its date arrives, so the close never steps twice. Closed
 * months stay strictly at their month-end. Per-account rows and consolidated bucket totals read
 * the same balance reader, so they cannot dip apart.
 */
describe("monthEndCloseClpForAccount with future-dated movements", () => {
  let clpId = 0;
  let leafSlug = "";

  beforeEach(() => {
    const clpLeaf = db
      .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE '%__clp' LIMIT 1`)
      .get() as { id: number; slug: string } | undefined;
    if (!clpLeaf) return;
    leafSlug = clpLeaf.slug;

    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(FIXTURE);
    clpId = Number(
      db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`).run(clpLeaf.id, FIXTURE)
        .lastInsertRowid
    );

    // Frozen "today" = 2099-07-15 Chile (dates far in the future so no live rows collide).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2099-07-15T12:00:00-04:00"));

    const ins = db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, ?, 'clp', ?, ?, ?)`
    );
    // Closed prior month: deposit that must keep counting at its month-end.
    ins.run(clpId, 1_000_000, "2099-06-20", `${FIXTURE}|jun-deposit`, "deposit_clp");
    // Current month, before today: counts.
    ins.run(clpId, 2_000_000, "2099-07-10", `${FIXTURE}|jul-deposit`, "deposit_clp");
    // Current month, AFTER today (settles later): already counts in the live close.
    ins.run(clpId, 2_985_000, "2099-07-20", `${FIXTURE}|jul-future-buy`, "withdrawal_clp");
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE}%`);
    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(FIXTURE);
  });

  it("marks the current-month close at Chile-today with every known movement, forward-dated included", () => {
    if (!clpId) return;
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-07");
    expect(close).toBe(15_000); // 1M (June) + 2M (July ≤ today) − 2.985M dated July 20: known, so counted
  });

  it("keeps closed months anchored at their month-end", () => {
    if (!clpId) return;
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-06");
    expect(close).toBe(1_000_000);
  });

  it("still counts the movement exactly once when today reaches its date", () => {
    if (!clpId) return;
    vi.setSystemTime(new Date("2099-07-20T12:00:00-04:00"));
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-07");
    expect(close).toBe(15_000); // 3M − 2.985M — unchanged from the day before: no double step
  });

  it("consolidation monthly rows evaluate the current month at today, closed months at month-end", () => {
    if (!clpId) return;
    const rows = loadAccountRowsForGroupConsolidation(clpId, leafSlug, "clp");
    const byMonth = new Map(rows.map((r) => [r.as_of_date.slice(0, 7), r.closing_value]));
    expect(byMonth.get("2099-06")).toBe(1_000_000);
    expect(byMonth.get("2099-07")).toBe(15_000); // the live month reads every known row, like the balance
  });
});
