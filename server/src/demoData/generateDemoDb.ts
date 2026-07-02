/**
 * Orchestrates synthetic DB generation for a preset (see `demoNarrative.ts`). The target
 * database is whatever `NW_TRACKER_TEST_DB` pointed `db.ts` at — callers are responsible
 * for pointing it at a FRESH file (this module refuses to write into a DB that already
 * has accounts, so it can never touch `nw-tracker.db`).
 */
import { db } from "../db.js";
import { seedNavTree } from "../seedNavTree.js";
import { seedCreditCardTree } from "../seedCreditCardTree.js";
import { ensureAccountSyncSourcesSeeded } from "../accountSyncSources.js";
import { recomputeCcBillingMonthBalances } from "../ccBillingBalances.js";
import { expandYearMonthsInclusive } from "../calendarMonth.js";
import { demoNarrativeForPreset, demoRng, type DemoPreset } from "./demoNarrative.js";
import {
  DEMO_FONDO_FUND_SERIES_KEY,
  initialDemoRunState,
  writeDemoPriceSeries,
  seedDemoCheckingBillCategoryRules,
  seedDemoEventAndUsdCategoryRules,
  seedDemoGenericTransferMerchants,
  seedDemoMerchantCategoryRules,
  writeCheckingMonth,
  writeCreditCardMonth,
  writeInvestmentMonth,
  writeMarketSeries,
  type DemoAccounts,
} from "./demoWriters.js";

function assertFreshDb(): void {
  if (!process.env.NW_TRACKER_TEST_DB?.trim()) {
    throw new Error(
      "Set NW_TRACKER_TEST_DB to a fresh DB file before generating (refusing to touch nw-tracker.db)."
    );
  }
  const n = (db.prepare(`SELECT COUNT(*) AS c FROM accounts`).get() as { c: number }).c;
  if (n > 0) {
    throw new Error(`target DB already has ${n} accounts — point NW_TRACKER_TEST_DB at a fresh file.`);
  }
}

/** brokerage_acciones leaves exist for the real tickers; demo tickers may need new ones. */
function ensureAccionesLeaf(ticker: string): number {
  const slug = `brokerage_acciones__${ticker.toLowerCase()}`;
  const existing = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const parent = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage_acciones'`)
    .get() as { id: number } | undefined;
  if (!parent) throw new Error("asset_groups missing brokerage_acciones");
  return Number(
    db
      .prepare(
        `INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, 90, ?)`
      )
      .run(slug, ticker, parent.id).lastInsertRowid
  );
}

function assetGroupId(slug: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`asset_groups slug missing: ${slug} (schema seed incomplete?)`);
  return row.id;
}

function createAccount(groupSlug: string, name: string, notes: string): number {
  return Number(
    db
      .prepare(`INSERT INTO accounts (asset_group_id, name, notes) VALUES (?, ?, ?)`)
      .run(assetGroupId(groupSlug), name, notes).lastInsertRowid
  );
}

export type GenerateDemoDbResult = {
  months: number;
  movements: number;
  valuations: number;
  statements: number;
  statementLines: number;
  installmentPurchases: number;
};

export function generateDemoDb(preset: DemoPreset): GenerateDemoDbResult {
  assertFreshDb();
  const narrative = demoNarrativeForPreset(preset);

  const checkingId = createAccount(
    "cash_eqs__cuenta_corriente",
    "Cuenta corriente",
    "demo:checking"
  );
  const ccMasterIdByLast4 = new Map<string, number>();
  for (const card of narrative.cards) {
    const id = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, account_kind) VALUES (?, ?, ?, 'master')`
        )
        .run(
          assetGroupId("credit_cards__credit_card"),
          card.displayName,
          `credit_card_master|${card.cardGroup}|${card.last4}`
        ).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4)
       VALUES (?, 21, 20, ?)`
    ).run(id, card.last4);
    ccMasterIdByLast4.set(card.last4, id);
  }
  const accounts: DemoAccounts = {
    checkingId,
    ccMasterIdByLast4,
    fondoId: Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key)
           VALUES (?, 'Fondo Moderado', 'demo:fondo', ?)`
        )
        .run(
          assetGroupId("brokerage_mutual_funds__fintual_risky_norris"),
          DEMO_FONDO_FUND_SERIES_KEY
        ).lastInsertRowid
    ),
    afpId: narrative.withAfp
      ? createAccount("retirement_afp_afc__afp", "AFP", "demo:afp")
      : null,
    afcId: narrative.withAfp
      ? createAccount("retirement_afp_afc__afc", "AFC", "demo:afc")
      : null,
    stockIdByTicker: new Map(
      (narrative.stocks?.positions ?? []).map((p) => {
        const id = Number(
          db
            .prepare(
              `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
               VALUES (?, ?, ?, ?)`
            )
            .run(
              ensureAccionesLeaf(p.ticker),
              p.ticker,
              `import:panel|ticker=${p.ticker}|key=demo_${p.ticker.toLowerCase()}`,
              p.ticker
            ).lastInsertRowid
        );
        return [p.ticker, id] as const;
      })
    ),
    usdCashId: narrative.stocks
      ? createAccount("brokerage_cash__usd", "USD", "demo:usd-cash")
      : null,
    cryptoId: narrative.withCrypto
      ? Number(
          db
            .prepare(
              `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker)
               VALUES (?, 'Bitcoin', 'demo:crypto', 'BTC-USD')`
            )
            .run(assetGroupId("brokerage_crypto__bitcoin")).lastInsertRowid
        )
      : null,
    savingsId: createAccount(
      "cash_eqs__fondo_reserva",
      "Fondo reserva",
      "demo:savings"
    ),
    vistaId: createAccount("cash_eqs__cuenta_vista", "Cuenta vista", "demo:vista"),
    propertyId: narrative.withProperty
      ? createAccount(
          "real_estate__property",
          narrative.house ? "Casa propia" : "Depto propio (pie)",
          // Canonical depto identity: the movements loader, mortgage pages, and the
          // manual payment form all resolve the property by these notes.
          "import:excel|key=property"
        )
      : null,
    // Mortgage master: notes are the canonical identity ensureMortgageLiabilityView keys on.
    mortgageId:
      narrative.withProperty && narrative.house
        ? createAccount(
            "liabilities__mortgage",
            "Casa propia",
            "import:excel|key=mortgage"
          )
        : null,
  };
  seedCreditCardTree();
  seedNavTree();

  const rng = demoRng(narrative.seed);
  writeMarketSeries(narrative, rng);
  const state = initialDemoRunState(narrative, rng);
  writeDemoPriceSeries(state);
  const months = expandYearMonthsInclusive(narrative.firstMonth, narrative.lastMonth);
  for (const month of months) {
    const { flows, afpContribClp } = writeCheckingMonth(narrative, accounts, month, state, rng);
    writeCreditCardMonth(narrative, accounts, month, state, rng);
    writeInvestmentMonth(narrative, accounts, month, state, flows, afpContribClp, rng);
  }
  for (const id of ccMasterIdByLast4.values()) {
    recomputeCcBillingMonthBalances(id);
  }
  seedDemoMerchantCategoryRules([...ccMasterIdByLast4.values()]);
  seedDemoCheckingBillCategoryRules(checkingId, narrative);
  seedDemoGenericTransferMerchants();
  seedDemoEventAndUsdCategoryRules(narrative, checkingId, accounts.vistaId, [
    ...ccMasterIdByLast4.values(),
  ]);
  ensureAccountSyncSourcesSeeded();
  seedNavTree();

  const totals = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM movements) AS movs,
              (SELECT COUNT(*) FROM valuations) AS vals,
              (SELECT COUNT(*) FROM cc_statements) AS stmts,
              (SELECT COUNT(*) FROM cc_statement_lines) AS lines,
              (SELECT COUNT(*) FROM cc_installment_purchases) AS purchases`
    )
    .get() as { movs: number; vals: number; stmts: number; lines: number; purchases: number };
  return {
    months: months.length,
    movements: totals.movs,
    valuations: totals.vals,
    statements: totals.stmts,
    statementLines: totals.lines,
    installmentPurchases: totals.purchases,
  };
}
