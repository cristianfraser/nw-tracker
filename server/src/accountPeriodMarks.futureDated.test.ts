import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "./db.js";
import { monthEndCloseClpForAccount } from "./accountPeriodMarks.js";
import { loadAccountRowsForGroupConsolidation } from "./groupMonthlyPerfConsolidation.js";

const FIXTURE = "vitest-future-dated-clp-cash";

/**
 * Current-month closings must be marked as of Chile-today, not the future month-end:
 * ledger cash accounts sum movements through the mark date, so a movement dated later
 * in the month (e.g. a stock_buy settling tomorrow) must not count until its date
 * arrives — otherwise consolidated bucket totals dip while per-account rows stay right.
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
      `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind) VALUES (?, ?, ?, ?, ?)`
    );
    // Closed prior month: deposit that must keep counting at its month-end.
    ins.run(clpId, 1_000_000, "2099-06-20", `${FIXTURE}|jun-deposit`, "deposit_clp");
    // Current month, before today: counts.
    ins.run(clpId, 2_000_000, "2099-07-10", `${FIXTURE}|jul-deposit`, "deposit_clp");
    // Current month, AFTER today (settles later): must NOT count yet.
    ins.run(clpId, 2_985_000, "2099-07-20", `${FIXTURE}|jul-future-buy`, "withdrawal_clp");
  });

  afterEach(() => {
    vi.useRealTimers();
    db.prepare(`DELETE FROM movements WHERE note LIKE ?`).run(`${FIXTURE}%`);
    db.prepare(`DELETE FROM accounts WHERE name = ?`).run(FIXTURE);
  });

  it("caps the current-month close at Chile-today (future-dated movement excluded)", () => {
    if (!clpId) return;
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-07");
    expect(close).toBe(3_000_000); // 1M (June) + 2M (July ≤ today); NOT −2.985M from July 20
  });

  it("keeps closed months anchored at their month-end", () => {
    if (!clpId) return;
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-06");
    expect(close).toBe(1_000_000);
  });

  it("counts the movement once today reaches its date", () => {
    if (!clpId) return;
    vi.setSystemTime(new Date("2099-07-20T12:00:00-04:00"));
    const close = monthEndCloseClpForAccount(clpId, leafSlug, [], "2099-07");
    expect(close).toBe(15_000); // 3M − 2.985M
  });

  it("consolidation monthly rows evaluate the current month at today, closed months at month-end", () => {
    if (!clpId) return;
    const rows = loadAccountRowsForGroupConsolidation(clpId, leafSlug, "clp");
    const byMonth = new Map(rows.map((r) => [r.as_of_date.slice(0, 7), r.closing_value]));
    expect(byMonth.get("2099-06")).toBe(1_000_000);
    expect(byMonth.get("2099-07")).toBe(3_000_000); // NOT 15.000: July 20 hasn't happened yet
  });
});
