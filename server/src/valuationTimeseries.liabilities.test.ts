import { describe, expect, it } from "vitest";
import { db } from "./db.js";
import { listLiabilitiesTabAccountRows } from "./valuationTimeseries.js";

describe("listLiabilitiesTabAccountRows", () => {
  it("excludes legacy combined worldmember when per-card Santander masters exist", () => {
    const perCard = db
      .prepare(`SELECT 1 AS o FROM accounts WHERE notes LIKE 'credit_card_master|santander|%' LIMIT 1`)
      .get() as { o: number } | undefined;
    if (!perCard) return;

    const legacyMaster = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=credit_card' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!legacyMaster) return;

    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    const seriesIds = new Set(
      ccRows.map((r) => {
        const src = db
          .prepare(`SELECT source_account_id FROM accounts WHERE id = ?`)
          .get(r.account_id) as { source_account_id: number | null } | undefined;
        return src?.source_account_id ?? r.account_id;
      })
    );
    expect(seriesIds.has(legacyMaster.id)).toBe(false);
    expect(ccRows.length).toBeGreaterThan(0);
  });

  it("includes mortgage liability_view for hipoteca tab", () => {
    const mtgRows = listLiabilitiesTabAccountRows("mortgage");
    const master = db
      .prepare(`SELECT id FROM accounts WHERE notes = 'import:excel|key=mortgage' LIMIT 1`)
      .get() as { id: number } | undefined;
    if (!master) return;
    expect(mtgRows.length).toBeGreaterThan(0);
    const view = db
      .prepare(
        `SELECT id FROM accounts WHERE source_account_id = ? AND account_kind = 'liability_view'`
      )
      .get(master.id) as { id: number } | undefined;
    if (!view) return;
    expect(mtgRows.some((r) => r.account_id === view.id)).toBe(true);
  });

  it("returns at most one row per operational credit card series", () => {
    const ccRows = listLiabilitiesTabAccountRows("credit_card");
    if (ccRows.length < 2) return;
    const seriesIds: number[] = [];
    for (const r of ccRows) {
      const src = db
        .prepare(`SELECT source_account_id FROM accounts WHERE id = ?`)
        .get(r.account_id) as { source_account_id: number | null } | undefined;
      seriesIds.push(src?.source_account_id ?? r.account_id);
    }
    expect(new Set(seriesIds).size).toBe(seriesIds.length);
  });
});
