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
/** Brokerage sub-bucket by slug, created under `brokerage` when the baseline lacks it
 * (e.g. `brokerage_long_term` — only generated DBs have that bucket). */
function ensureBrokerageBucket(slug: string, label: string, sortOrder: number): number {
  const existing = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const parent = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'brokerage'`).get() as
    | { id: number }
    | undefined;
  if (!parent) throw new Error("asset_groups missing brokerage");
  return Number(
    db
      .prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`)
      .run(slug, label, sortOrder, parent.id).lastInsertRowid
  );
}

function ensureTickerLeaf(bucketSlug: string, bucketLabel: string, ticker: string): number {
  const slug = `${bucketSlug}__${ticker.toLowerCase()}`;
  const existing = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const parentId = ensureBrokerageBucket(bucketSlug, bucketLabel, 15);
  return Number(
    db
      .prepare(
        `INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, 90, ?)`
      )
      .run(slug, ticker, parentId).lastInsertRowid
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

function createTickerAccount(bucketSlug: string, bucketLabel: string, ticker: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO accounts (asset_group_id, name, notes, equity_ticker) VALUES (?, ?, ?, ?)`
      )
      .run(
        ensureTickerLeaf(bucketSlug, bucketLabel, ticker),
        ticker,
        `import:panel|ticker=${ticker}|key=demo_${ticker.toLowerCase()}`,
        ticker
      ).lastInsertRowid
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

/**
 * Colors lifted from the author's live dashboard (portfolio_groups.color_rgb +
 * accounts.color_rgb) so the demo reads like the real thing. Bitcoin carries the
 * brokerage_crypto group gold directly (the real account inherits it from the group).
 */
const DEMO_GROUP_COLORS: ReadonlyArray<[slug: string, rgb: string]> = [
  ["net_worth", "255,255,255"],
  ["inversiones", "17,19,143"],
  ["brokerage", "36,36,191"],
  ["brokerage_acciones", "29,153,168"],
  ["brokerage_long_term", "35,55,217"],
  ["brokerage_crypto", "234,179,8"],
  ["cash_eqs", "160,218,232"],
  ["cash_savings", "157,227,245"],
  ["liabilities", "143,24,24"],
  ["liabilities_ref_disponible", "94,234,212"],
  ["liabilities_ref_disponible_total", "45,212,191"],
  ["real_estate", "91,40,189"],
  ["retirement", "26,171,19"],
  ["retirement_afp_afc", "32,201,58"],
  ["retirement_apv", "38,181,126"],
];

function applyDemoColors(accounts: DemoAccounts): void {
  const updGroup = db.prepare(`UPDATE portfolio_groups SET color_rgb = ? WHERE slug = ?`);
  for (const [slug, rgb] of DEMO_GROUP_COLORS) updGroup.run(rgb, slug);

  const updAccount = db.prepare(`UPDATE accounts SET color_rgb = ? WHERE id = ?`);
  updAccount.run("161,11,29", accounts.checkingId);
  if (accounts.fondoId != null) updAccount.run("35,55,217", accounts.fondoId);
  if (accounts.cryptoId != null) updAccount.run("234,179,8", accounts.cryptoId);
  if (accounts.usdCashId != null) updAccount.run("90,90,150", accounts.usdCashId);
  const ccj = accounts.stockIdByTicker.get("CCJ");
  if (ccj != null) updAccount.run("80,184,176", ccj);
  // Card colors by group (santander blue-gray / bci amber, like the real masters).
  const updByNotes = db.prepare(
    `UPDATE accounts SET color_rgb = ? WHERE notes LIKE ? AND account_kind = 'master'`
  );
  updByNotes.run("75,153,189", "credit_card_master|santander|%");
  updByNotes.run("180,120,60", "credit_card_master|bci|%");
}

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
    fondoId: narrative.withFondo
      ? Number(
          db
            .prepare(
              `INSERT INTO accounts (asset_group_id, name, notes, fund_series_key)
               VALUES (?, 'Fondo Moderado', 'demo:fondo', ?)`
            )
            .run(
              assetGroupId("brokerage_mutual_funds__fintual_risky_norris"),
              DEMO_FONDO_FUND_SERIES_KEY
            ).lastInsertRowid
        )
      : null,
    afpId: narrative.withAfp
      ? createAccount("retirement_afp_afc__afp", "AFP", "demo:afp")
      : null,
    afcId: narrative.withAfp
      ? createAccount("retirement_afp_afc__afc", "AFC", "demo:afc")
      : null,
    stockIdByTicker: new Map([
      ...(narrative.stocks?.positions ?? []).map(
        (p) => [p.ticker, createTickerAccount("brokerage_acciones", "Acciones", p.ticker)] as const
      ),
      ...(narrative.stocks?.longTermPositions ?? []).map(
        (p) => [p.ticker, createTickerAccount("brokerage_long_term", "Long-term", p.ticker)] as const
      ),
    ]),
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
  applyDemoColors(accounts);

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
