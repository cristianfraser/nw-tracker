import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { clearAggregationCache } from "./cacheRegistry.js";
import { cardValueInUnit } from "./cardValueInUnit.js";
import { applyCreditCardConfigPatch, getCreditCardAccountConfig } from "./ccAccountConfig.js";
import { writeCcOwedAnchor } from "./ccCreditCardValuations.js";
import { ccOwedByCurrencyAtYmd, ccOwedClpAtYmd, ccRevaluationCostByDate } from "./ccOwedWalk.js";
import { chileCalendarTodayYmd } from "./chileDate.js";
import { db } from "./db.js";
import { snapshotTables } from "./test/snapshotTables.js";

/**
 * A card that bills in euros (docs/any-currency-plan.md, Phase C3; the fictional issuer
 * `euronova`): its statement lines store their amount in euros (migration 319), the owed walk keeps
 * a euro sub-balance beside the pesos, values it at the day's EUR/CLP at the debt side, and the
 * day-to-day move of that rate on the euros carried over is the card's fx cost.
 */

const restoreTables = snapshotTables(["eur_daily"]);

const TODAY = chileCalendarTodayYmd();
function addDaysIso(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
function ddmmyyyy(iso: string): string {
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
}

const ANCHOR = addDaysIso(TODAY, -20);
const CHARGE = addDaysIso(TODAY, -15);
const MOVE = addDaysIso(TODAY, -10);
const END = addDaysIso(TODAY, -1);
const CLP_PER_EUR = [1000, 1050] as const;

let ccId: number | null = null;
let lineId = 0;

beforeAll(() => {
  db.prepare(`DELETE FROM eur_daily`).run();
  const leaf = db
    .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
    .get() as { id: number } | undefined;
  if (!leaf) throw new Error("no credit-card asset group in the test database");
  ccId = Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, import_key)
         VALUES (?, 'Vitest · euro card', 'vitest-euro-card', 'credit_card_master|euronova|vitest-euro-card')`
      )
      .run(leaf.id).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
     VALUES (?, '4401', 16, 15, 'euronova')`
  ).run(ccId);
  db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(addDaysIso(ANCHOR, -40), CLP_PER_EUR[0]);
  db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, ?)`).run(MOVE, CLP_PER_EUR[1]);
  const statementId = Number(
    db
      .prepare(
        `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, currency, layout)
         VALUES (?, 'EURONOVA', 'vitest-euro-statement.pdf', ?, 'eur', 'compact')`
      )
      .run(ccId, ddmmyyyy(addDaysIso(TODAY, 5))).lastInsertRowid
  );
  lineId = Number(
    db
      .prepare(
        `INSERT INTO cc_statement_lines (statement_id, transaction_date, merchant, amount, currency, installment_flag, dedupe_key)
         VALUES (?, ?, 'BOULANGERIE VITEST', 40.5, 'eur', 0, 'vitest-euro-line')`
      )
      .run(statementId, ddmmyyyy(CHARGE)).lastInsertRowid
  );
  writeCcOwedAnchor(ccId, ANCHOR, { clp: 0, eur: 200 });
  clearAggregationCache();
});

afterAll(() => {
  if (ccId != null) {
    db.prepare(`DELETE FROM cc_statements WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM cc_owed_anchors WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM credit_card_account_config WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(ccId);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(ccId);
  }
  restoreTables();
  clearAggregationCache();
});

describe("a card that bills in euros", () => {
  it("stores the line in euros; the legacy peso and dollar columns read nothing", () => {
    const row = db
      .prepare(
        `SELECT l.amount, l.currency, l.amount_clp, l.amount_usd, l.valor_cuota_mensual_clp, l.kind, f.amount AS flow_amount, f.currency AS flow_currency
         FROM cc_statement_lines l JOIN flows f ON f.id = l.flow_id WHERE l.id = ?`
      )
      .get(lineId);
    expect(row).toEqual({
      amount: 40.5,
      currency: "eur",
      amount_clp: null,
      amount_usd: null,
      valor_cuota_mensual_clp: null,
      kind: "card_purchase",
      flow_amount: 40.5,
      flow_currency: "eur",
    });
  });

  it("walks a euro sub-balance and values it at the day's EUR/CLP", () => {
    expect(ccOwedByCurrencyAtYmd(ccId!, END)).toEqual({ owed: { clp: 0, eur: 240.5 }, as_of_date: ANCHOR });
    expect(ccOwedClpAtYmd(ccId!, addDaysIso(CHARGE, 1))!.value_clp).toBe(Math.round(240.5 * CLP_PER_EUR[0]));
    expect(ccOwedClpAtYmd(ccId!, END)!.value_clp).toBe(Math.round(240.5 * CLP_PER_EUR[1]));
    expect(cardValueInUnit(ccId!, 0, END, "eur")).toBeCloseTo(240.5, 6);
  });

  it("lists and sets its cupo in euros, the one currency it bills in", () => {
    expect(getCreditCardAccountConfig(ccId!).cupo).toEqual([{ currency: "eur", value: null }]);
    applyCreditCardConfigPatch(ccId!, { cupo: [{ currency: "eur", value: 2500 }] });
    expect(getCreditCardAccountConfig(ccId!).cupo).toEqual([{ currency: "eur", value: 2500 }]);
    expect(() => applyCreditCardConfigPatch(ccId!, { cupo: [{ currency: "usd", value: 1 }] })).toThrow(/not a currency this card bills in/);
  });

  it("books the rate move on the euros carried over as the card's fx cost in pesos", () => {
    const cost = ccRevaluationCostByDate(ccId!, "clp");
    expect(cost.get(MOVE)).toBeCloseTo(240.5 * (CLP_PER_EUR[1] - CLP_PER_EUR[0]), 6);
    expect([...cost.keys()]).toEqual([MOVE]);
  });
});
