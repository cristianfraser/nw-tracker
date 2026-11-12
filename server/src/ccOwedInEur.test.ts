import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { cardValueInUnit } from "./cardValueInUnit.js";
import { writeCcOwedAnchor } from "./ccCreditCardValuations.js";
import { ccFinancingCostByDateInUnit } from "./ccFinancingCostDaily.js";
import { ccOwedByCurrencyAtYmd, ccOwedClpAtYmd } from "./ccOwedWalk.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";
import { convertValue } from "./valueConvert.js";

/**
 * A card's owed in euros: each native sub-balance (pesos, dollars) converts on its own into the
 * unit at the debt side — pesos through EUR/CLP, dollars through EUR/USD — never the peso total ÷
 * a rate, and the day-to-day move of both rates on what is carried over is the card's fx P/L.
 */

const restoreTables = snapshotTables(["eur_daily", "fx_rates"]);

const TODAY = chileCalendarTodayYmd();
function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const ANCHOR = addDaysIso(TODAY, -20);
const MOVE = addDaysIso(TODAY, -10);
const END = addDaysIso(TODAY, -1);
const CLP_PER_EUR = [1000, 1050] as const;
const USD_PER_EUR = [1.1, 1.2] as const;

let ccId: number | null = null;

beforeAll(() => {
  // The synthetic market writes EUR rates; this test states its own.
  db.prepare(`DELETE FROM eur_daily`).run();
  db.prepare(`DELETE FROM fx_rates WHERE base = 'eur' OR quote = 'eur'`).run();
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) return;
  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · eur owed card', 'vitest-eur-owed', 'credit_card_master|santander|vitest-eur-owed')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '7780', 21, 20, 'santander')`
  ).run(ccId);
  // Rates from before the anchor through the move day, then the move: both pairs step on MOVE.
  for (const [day, i] of [
    [addDaysIso(ANCHOR, -5), 0],
    [MOVE, 1],
  ] as const) {
    db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(day, CLP_PER_EUR[i]);
    db.prepare(`INSERT OR REPLACE INTO fx_rates (base, quote, date, mid, source) VALUES ('eur', 'usd', ?, ?, 'vitest')`).run(
      day,
      USD_PER_EUR[i]
    );
  }
  writeCcOwedAnchor(ccId, ANCHOR, { clp: 210_000, usd: 120 });
  clearAggregationCache();
});

afterAll(() => {
  if (ccId != null) {
    db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  }
  restoreTables();
  clearAggregationCache();
});

describe("a card's owed in euros", () => {
  it("converts each sub-balance into euros at the debt side", () => {
    expect(ccId).not.toBeNull();
    if (ccId == null) return;
    expect(ccOwedByCurrencyAtYmd(ccId, END)).toMatchObject({ clp: 210_000, usd: 120 });
    const owedClp = ccOwedClpAtYmd(ccId, END)!.value_clp;
    const eur = cardValueInUnit(ccId, owedClp, END, "eur")!;
    // 210.000 pesos at 1.050 per euro, US$120 at 1,2 dollars per euro.
    expect(eur).toBeCloseTo(210_000 / 1050 + 120 / 1.2, 9);
    expect(eur).toBeCloseTo(convertValue(210_000, "clp", "eur", END, "debt")! + convertValue(120, "usd", "eur", END, "debt")!, 9);
    // Before the move, the earlier rates.
    expect(cardValueInUnit(ccId, ccOwedClpAtYmd(ccId, ANCHOR)!.value_clp, ANCHOR, "eur")).toBeCloseTo(
      210_000 / 1000 + 120 / 1.1,
      9
    );
  });

  it("the rates' move on the carried sub-balances is the card's cost in euros", () => {
    if (ccId == null) return;
    const cost = ccFinancingCostByDateInUnit(ccId, "eur");
    let sum = 0;
    for (const [d, c] of cost) if (d > ANCHOR && d <= END) sum += c;
    // Nothing was charged or paid: the whole change in the euro value is revaluation.
    const v0 = 210_000 / 1000 + 120 / 1.1;
    const v1 = 210_000 / 1050 + 120 / 1.2;
    expect(sum).toBeCloseTo(v1 - v0, 9);
    expect([...cost.keys()].filter((d) => d > ANCHOR && d <= END)).toEqual([MOVE]);
  });
});
