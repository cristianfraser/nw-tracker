import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildAccountDetailBundle } from "./accountDetailBundle.js";
import { accountMarkClpAtYmd } from "./accountMarkClpAtYmd.js";
import { clearAggregationCache } from "./aggregationCache.js";
import { chileCalendarAddDays, chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";

const IMPORT_KEY = "vitest-account-display-value-manual";
const NAME = "Vitest · display value manual";

let accountId: number | null = null;
let leafSlug: string | null = null;

beforeAll(() => {
  const leaf = db
    .prepare(`SELECT id, slug FROM asset_groups WHERE slug LIKE 'brokerage_acciones__%' LIMIT 1`)
    .get() as { id: number; slug: string } | undefined;
  if (!leaf) return;
  leafSlug = leaf.slug;

  // A manual-marked account (stored valuations only) with a deposit after its last mark.
  accountId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`
      )
      .run(leaf.id, NAME, IMPORT_KEY, IMPORT_KEY).lastInsertRowid
  );
  const today = chileCalendarTodayYmd();
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, 500000, 'clp')`
  ).run(accountId, chileCalendarAddDays(today, -10));
  db.prepare(
    `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
     VALUES (?, 50000, 'clp', ?, 'vitest-account-display-value-deposit')`
  ).run(accountId, chileCalendarAddDays(today, -3));

  // Fixture rows were written on this connection (no data_version bump).
  clearAggregationCache();
});

afterAll(() => {
  if (accountId != null) {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
  }
  clearAggregationCache();
});

describe("account value today", () => {
  it("the page header and the dashboard row both show the mark carried by later deposits", async () => {
    if (accountId == null || leafSlug == null) return;
    const mark = accountMarkClpAtYmd(accountId, chileCalendarTodayYmd(), leafSlug, {
      import_key: IMPORT_KEY,
      name: NAME,
    });
    expect(mark?.value_clp).toBe(550_000);

    const bundle = await buildAccountDetailBundle(accountId, "clp", "monthly");
    expect(bundle?.summary.latest_valuation_clp).toBe(550_000);
    expect(bundle?.dashboard_account_row?.current_value_clp).toBe(550_000);
  });
});
