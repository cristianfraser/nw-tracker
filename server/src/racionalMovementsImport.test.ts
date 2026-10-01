import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BrokerMovementsPayload } from "nw-tracker-contracts";
import { brokerCleanThrough } from "./brokerReadCoverage.js";
import { db } from "./db.js";
import {
  applyRacionalDividendDetails,
  applyRacionalRead,
  markDuplicates,
  planRacionalDividendDetails,
  planRacionalMovement,
  planRacionalMovements,
  racionalComisionCrawlDue,
} from "./racionalMovementsImport.js";
import { getMovementDividendDetail } from "./movementDividendDetails.js";
import type { RacionalPlannedMovement } from "./racionalMovementsImport.js";
import { brokerMovement } from "./test/brokerMovementFixtures.js";

/**
 * Duplicate detection has to survive how the ledger actually looks, which real data showed is
 * not one-row-per-feed-row: the 2026-03-05 VEA purchase the app reports as a single US$xxx,xx
 * line exists as TWO ledger rows that add up to it, and the 2026-03-26 one is recorded at
 * US$xx,xx against the feed's US$54,68. Matching a single row by exact amount misses both and
 * would import a second copy of each.
 */
describe("racionalMovementsImport duplicate detection", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) {
      db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    }
  });

  function twoAccounts(): { from: number; to: number } {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[];
    if (rows.length < 2) throw new Error("need two accounts in the test DB");
    return { from: rows[0]!.id, to: rows[1]!.id };
  }

  function seedTransfer(from: number, to: number, amount: number, day = "2026-03-05"): number {
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, ?, 'usd', ?, 'vitest-racional')`
    ).run(from, to, amount, day);
    const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(id);
    return id;
  }

  /** A planned buy with the accounts overridden, so the test needs no real Racional wiring. */
  function plannedBuy(from: number, to: number, amount: number, day = "2026-03-05"): RacionalPlannedMovement {
    const source = brokerMovement({
      kind: "buy",
      title: "Compra VEA",
      occurred_on: day,
      amount,
      currency: "usd",
      ticker: "VEA",
      units: "1.00000000",
      price: 1,
      order_id: "TEST",
    });
    return {
      source,
      from_account_id: from,
      to_account_id: to,
      account_id: null,
      amount,
      currency: "usd",
      units_delta: "1.00000000",
      flow_kind: "stock_buy",
      note: "vitest",
      duplicate_of: null,
      requires_manual: null,
      conflict: null,
      blocked: null,
    };
  }

  it("treats a purchase split across several ledger rows as already imported", () => {
    const { from, to } = twoAccounts();
    const first = seedTransfer(from, to, 264.35);
    seedTransfer(from, to, 64.04); // 264.35 + 64.04 = 328.39

    const [marked] = markDuplicates([plannedBuy(from, to, 328.39)]);
    expect(marked!.duplicate_of).toBe(first);
    expect(marked!.requires_manual).toBeNull();
  });

  it("flags a near-miss as a conflict instead of importing a second copy", () => {
    const { from, to } = twoAccounts();
    const existing = seedTransfer(from, to, 55.22, "2026-03-26");

    const [marked] = markDuplicates([plannedBuy(from, to, 54.68, "2026-03-26")]);
    expect(marked!.duplicate_of).toBeNull();
    // A conflict, not `requires_manual`: the ledger and the feed disagree about one movement,
    // which is a data error that must fail the step (the gross-booked SOXX dividend of
    // 2026-09-18 sat as an «ok» log line for four days as a requires_manual).
    expect(marked!.requires_manual).toBeNull();
    expect(marked!.conflict).toMatch(/totalling 55\.22 usd vs the feed's 54\.68/);
    expect(marked!.conflict).toContain(String(existing));
  });

  it("leaves a genuinely new movement importable", () => {
    const { from, to } = twoAccounts();
    const [marked] = markDuplicates([plannedBuy(from, to, 999.99, "2026-04-17")]);
    expect(marked!.duplicate_of).toBeNull();
    expect(marked!.requires_manual).toBeNull();
  });

  it("never plans cash in or out as an automatic write", () => {
    // The synthetic test DB has no Racional cash account; create the CLP one this needs.
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Racional CLP', 0, datetime('now'), 'import:panel|kind=clp|key=clp')`
    ).run(group.id);
    const accountId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;

    try {
      for (const [title, kind] of [
        ["Depósito", "deposit"],
        ["Retiro", "withdrawal"],
      ] as const) {
        const planned = planRacionalMovement(
          brokerMovement({ kind, title, occurred_on: "2026-07-02", amount: 1_000_000, currency: "clp" })
        );
        // Its counterpart is a real bank movement that arrives via the checking importer.
        expect(planned.requires_manual).toMatch(/mirror-pairs/);
        expect(planned.account_id).toBe(accountId);
      }
    } finally {
      db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
    }
  });
});

describe("racional portafolio comisión (cash_fee)", () => {
  function ensureCashAccount(importKey: string, name: string): { id: number; cleanup: () => void } {
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as
      | { id: number }
      | undefined;
    if (existing) return { id: existing.id, cleanup: () => {} };
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as {
      id: number;
    };
    const id = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(group.id, name, importKey, importKey).lastInsertRowid
    );
    return { id, cleanup: () => db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id) };
  }

  /** Synthetic caja leaf + account (matches `portfolioCajaClpAccountId`'s GLOB). */
  function createCaja(): { accountId: number; cleanup: () => void } {
    const leafId = Number(
      db
        .prepare(`INSERT INTO asset_groups (slug, label, sort_order) VALUES (?, 'vitest caja', 9999)`)
        .run("brokerage_cash__caja_vitest__clp").lastInsertRowid
    );
    const accountId = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key)
           VALUES (?, 'vitest Caja IPSA', 'vitest-caja', 'vitest-caja-racional')`
        )
        .run(leafId).lastInsertRowid
    );
    return {
      accountId,
      cleanup: () => {
        db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
        db.prepare(`DELETE FROM accounts WHERE id = ?`).run(accountId);
        db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(leafId);
      },
    };
  }

  const feeMovement = () =>
    brokerMovement({ kind: "fee", title: "Comisión", occurred_on: "2026-08-18", amount: 2335, currency: "clp" });

  it("routes a CLP comisión to the portafolio caja as a cash_fee cost", () => {
    const clp = ensureCashAccount("import:panel|kind=clp|key=clp", "vitest Racional CLP");
    const caja = createCaja();
    try {
      const planned = planRacionalMovement(feeMovement());
      expect(planned).toMatchObject({
        account_id: caja.accountId,
        amount: -2335,
        currency: "clp",
        flow_kind: "cash_fee",
        requires_manual: null,
      });
    } finally {
      caja.cleanup();
      clp.cleanup();
    }
  });

  it("refuses to guess when no single caja exists", () => {
    const clp = ensureCashAccount("import:panel|kind=clp|key=clp", "vitest Racional CLP");
    try {
      const planned = planRacionalMovement(feeMovement());
      expect(planned.requires_manual ?? "").toContain("caja");
      expect(planned.flow_kind).toBe("cash_fee");
    } finally {
      clp.cleanup();
    }
  });

  it("marks an already-imported comisión as a duplicate (single-leg dedupe)", () => {
    const clp = ensureCashAccount("import:panel|kind=clp|key=clp", "vitest Racional CLP");
    const caja = createCaja();
    try {
      const existing = Number(
        db
          .prepare(
            `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
             VALUES (?, -2335, 'clp', '2026-08-18', 'vitest-racional', 'cash_fee')`
          )
          .run(caja.accountId).lastInsertRowid
      );
      const [marked] = markDuplicates([planRacionalMovement(feeMovement())]);
      expect(marked!.duplicate_of).toBe(existing);
    } finally {
      caja.cleanup();
      clp.cleanup();
    }
  });

  it("nudges a crawl from the 20th while the month's comisión is missing", () => {
    const caja = createCaja();
    try {
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, 10000, 'clp', '2020-01-05', 'vitest-caja-seed')`
      ).run(caja.accountId);

      expect(racionalComisionCrawlDue("2099-05-25").due).toBe(true);
      expect(racionalComisionCrawlDue("2099-05-15").due).toBe(false);

      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind)
         VALUES (?, -2335, 'clp', '2099-05-18', 'vitest-racional', 'cash_fee')`
      ).run(caja.accountId);
      expect(racionalComisionCrawlDue("2099-05-25").due).toBe(false);
    } finally {
      caja.cleanup();
    }
  });

  it("is never due without a caja account", () => {
    expect(racionalComisionCrawlDue("2099-05-25").due).toBe(false);
  });
});

/**
 * The dividends API is the only Racional source of the gross / withholding behind a credited
 * dividend (the mail states the gross, the list row the net). Each record is paired with the
 * ledger's dividend_payout row on the API's Chile day at the credited net; a row that reads
 * the gross instead is exactly the 2026-09-22 bug and must surface as a conflict.
 */
describe("racional dividend breakdowns from the dividends API file", () => {
  const created: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  });

  function twoAccounts(): { holder: number; cash: number } {
    const rows = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as { id: number }[];
    if (rows.length < 2) throw new Error("need two accounts in the test DB");
    return { holder: rows[0]!.id, cash: rows[1]!.id };
  }

  function seedDividend(holder: number, cash: number, amount: number, day: string): number {
    const id = Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
           VALUES (?, ?, ?, 'usd', ?, 'vitest-racional-dividend', 'dividend_payout')`
        )
        .run(holder, cash, amount, day).lastInsertRowid
    );
    created.push(id);
    return id;
  }

  // 11:56 UTC is 08:56 in Chile: the list row prints 18/09.
  const soxx = {
    id: "div_NI.vitest-uuid_VTSOX_2026-09-18T11:56:15.827Z",
    asset_id: "VTSOX",
    gross: 2.75,
    withholding: 0.41,
    net: 2.34,
    execution_date: "2026-09-18T11:56:15.827Z",
    is_interest: false,
  };

  it("pairs an API dividend with its ledger row on the Chile day and writes the breakdown", () => {
    const { holder, cash } = twoAccounts();
    const id = seedDividend(holder, cash, 2.34, "2026-09-18");
    const accounts = { holderFor: () => [holder], racionalUsd: cash };

    const [plan] = planRacionalDividendDetails([soxx], "dividends-vitest.json", accounts);
    expect(plan).toMatchObject({ chile_ymd: "2026-09-18", movement_id: id, conflict: null, skipped: null, already_recorded: false });

    expect(applyRacionalDividendDetails([plan!], "dividends-vitest.json")).toEqual([{ movement_id: id, outcome: "inserted" }]);
    expect(getMovementDividendDetail(id)).toMatchObject({
      gross_amount: 2.75,
      withholding_amount: 0.41,
      withholding_jurisdiction: "US",
      withholding_rate_pct: null,
      pay_date: "2026-09-18",
      broker_event_id: soxx.id,
      source: "racional_api",
      source_ref: "dividends-vitest.json",
    });

    const [again] = planRacionalDividendDetails([soxx], "dividends-vitest.json", accounts);
    expect(again!.already_recorded).toBe(true);
    expect(applyRacionalDividendDetails([again!], "dividends-vitest.json")).toEqual([{ movement_id: id, outcome: "unchanged" }]);
  });

  it("reports a gross-booked row as a conflict, a missing row as a conflict, and skips interest entries", () => {
    const { holder, cash } = twoAccounts();
    const accounts = { holderFor: () => [holder], racionalUsd: cash };

    const [missing] = planRacionalDividendDetails([soxx], "f.json", accounts);
    expect(missing!.conflict).toMatch(/no dividend_payout of VTSOX/);

    seedDividend(holder, cash, 2.75, "2026-09-18");
    const [gross] = planRacionalDividendDetails([soxx], "f.json", accounts);
    expect(gross!.conflict).toMatch(/read 2\.75 .* but Racional credited 2\.34/);

    const [interest] = planRacionalDividendDetails([{ ...soxx, id: "int-vitest", is_interest: true }], "f.json", accounts);
    expect(interest!.skipped).toMatch(/interest/);
    expect(interest!.conflict).toBeNull();
    expect(applyRacionalDividendDetails([interest!], "f.json")).toEqual([]);
  });
});

/**
 * 2026-09-26: the crawl staged a buy it could not open (no units, no id). It was long since in
 * the ledger, yet planning threw before duplicate detection ran — and since staged files are
 * never archived, that one row failed every night's import, the later files and the dividends
 * pass with it. The rules now: dedupe first, fail only a row that would be written, isolate the
 * failure to its file, and never move the watermark back.
 */
describe("racional reads — incomplete rows, read isolation, coverage", () => {
  const TICKER = "VTRACBUY";
  let usd: { id: number; cleanup: () => void };
  let equity: number;
  let coverageBefore: { clean_through: string; updated_at: string } | undefined;

  beforeEach(() => {
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = 'import:panel|kind=usd|key=usd'`).get() as
      | { id: number }
      | undefined;
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as { id: number };
    if (existing) {
      usd = { id: existing.id, cleanup: () => {} };
    } else {
      const id = Number(
        db
          .prepare(
            `INSERT INTO accounts (asset_group_id, name, notes, import_key)
             VALUES (?, 'vitest Racional USD', 'vitest:racional-import', 'import:panel|kind=usd|key=usd')`
          )
          .run(group.id).lastInsertRowid
      );
      usd = { id, cleanup: () => db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id) };
    }
    equity = Number(
      db
        .prepare(
          `INSERT INTO accounts (asset_group_id, name, notes, import_key, equity_ticker)
           VALUES (?, 'vitest VTRACBUY', 'vitest:racional-import', 'vitest:racional-import|VTRACBUY', ?)`
        )
        .run(group.id, TICKER).lastInsertRowid
    );
    coverageBefore = db.prepare(`SELECT clean_through, updated_at FROM broker_read_coverage WHERE broker = 'racional'`).get() as
      | { clean_through: string; updated_at: string }
      | undefined;
    db.prepare(`DELETE FROM broker_read_coverage WHERE broker = 'racional'`).run();
  });

  afterEach(() => {
    db.prepare(
      `DELETE FROM movement_dividend_details WHERE movement_id IN (
         SELECT id FROM movements WHERE occurred_on LIKE '2097-07-%'
           AND (account_id IN (?, ?) OR from_account_id IN (?, ?) OR to_account_id IN (?, ?)))`
    ).run(usd.id, equity, usd.id, equity, usd.id, equity);
    db.prepare(
      `DELETE FROM movements WHERE occurred_on LIKE '2097-07-%'
         AND (account_id IN (?, ?) OR from_account_id IN (?, ?) OR to_account_id IN (?, ?))`
    ).run(usd.id, equity, usd.id, equity, usd.id, equity);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(equity);
    usd.cleanup();
    db.prepare(`DELETE FROM broker_read_coverage WHERE broker = 'racional'`).run();
    if (coverageBefore) {
      db.prepare(`INSERT INTO broker_read_coverage (broker, clean_through, updated_at) VALUES ('racional', ?, ?)`).run(
        coverageBefore.clean_through,
        coverageBefore.updated_at
      );
    }
  });

  /** A buy the crawl listed but could not open: no share count. */
  const unopenedBuy = brokerMovement({
    kind: "buy",
    title: `Compra ${TICKER}`,
    occurred_on: "2097-07-01",
    amount: 1234.56,
    currency: "usd",
    ticker: TICKER,
    incomplete: "share count unknown — the crawl could not open its detail view (not among the 10 rendered rows)",
  });
  const interest = (ymd: string, amount: number) =>
    brokerMovement({ kind: "interest", title: "Intereses", occurred_on: ymd, amount, currency: "usd" });
  const apiDividend = {
    id: `div_NI.vitest-import_${TICKER}_2097-07-03T12:00:00.000Z`,
    asset_id: TICKER,
    gross: 1,
    withholding: 0.15,
    net: 0.85,
    execution_date: "2097-07-03T12:00:00.000Z",
    is_interest: false,
  };
  const read = (readAt: string, movements: BrokerMovementsPayload["movements"], dividends: BrokerMovementsPayload["dividends"] = null, apply = true) =>
    applyRacionalRead({ broker: "racional", apply, read_at: readAt, movements, dividends }, `movements-${readAt}.json`);

  function seedBuy(): number {
    return Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, units_delta, flow_kind)
           VALUES (?, ?, 1234.56, 'usd', '2097-07-01', 'vitest-racional-import', '3.5', 'stock_buy')`
        )
        .run(usd.id, equity).lastInsertRowid
    );
  }

  function seedDividend(): number {
    return Number(
      db
        .prepare(
          `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
           VALUES (?, ?, 0.85, 'usd', '2097-07-03', 'vitest-racional-import', 'dividend_payout')`
        )
        .run(equity, usd.id).lastInsertRowid
    );
  }

  const interestOn = (ymd: string) =>
    db
      .prepare(`SELECT amount FROM movements WHERE account_id = ? AND occurred_on = ? AND flow_kind = 'savings_earnings'`)
      .all(usd.id, ymd);

  it("plans an unopened buy the ledger already holds as already present", () => {
    const existing = seedBuy();
    const planned = planRacionalMovements([unopenedBuy]).planned;
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({ duplicate_of: existing, blocked: null, conflict: null });
  });

  it("a blocked read writes nothing and covers nothing; a later read and its dividends still apply", () => {
    const blocked = read("2097-07-02T01:00:00.000Z", [unopenedBuy, interest("2097-07-01", 0.05)]);
    expect(blocked.movements_blocked).toBe(true);
    expect(blocked.problems[0]).toMatch(new RegExp(`«Compra ${TICKER}» — share count unknown .* no ledger movement matches it`));
    // Nothing from the blocked list is written — not even its writable interest row.
    expect(interestOn("2097-07-01")).toEqual([]);
    expect(blocked).toMatchObject({ clean: false, clean_through: null, inserted: 0 });

    const dividend = seedDividend();
    const later = read("2097-07-03T01:00:00.000Z", [interest("2097-07-02", 0.07)], [apiDividend]);
    expect(later).toMatchObject({ clean: true, problems: [], inserted: 1, breakdowns_written: 1 });
    expect(interestOn("2097-07-02")).toEqual([{ amount: 0.07 }]);
    expect(getMovementDividendDetail(dividend)).toMatchObject({ gross_amount: 1, withholding_amount: 0.15, source: "racional_api" });
    expect(brokerCleanThrough("racional")).toBe("2097-07-03T01:00:00.000Z");
    // Sent again: everything is already there.
    expect(read("2097-07-03T01:00:00.000Z", [interest("2097-07-02", 0.07)], [apiDividend])).toMatchObject({
      inserted: 0,
      duplicates: 1,
      breakdowns_written: 0,
      clean: true,
    });
  });

  it("moves the coverage forward only, and only for a read of the list", () => {
    seedBuy(); // the unopened buy is in the ledger: the reads below are clean
    read("2097-07-05T01:00:00.000Z", [unopenedBuy]);
    read("2097-07-04T01:00:00.000Z", []); // an older quiet read arriving late
    expect(brokerCleanThrough("racional")).toBe("2097-07-05T01:00:00.000Z");
    // The dividends record alone says nothing about the movements a mail announced.
    expect(read("2097-07-09T01:00:00.000Z", null, [])).toMatchObject({ clean: false });
    // Report only covers nothing either.
    expect(read("2097-07-10T01:00:00.000Z", [], null, false)).toMatchObject({ applied: false, clean: true });
    expect(brokerCleanThrough("racional")).toBe("2097-07-05T01:00:00.000Z");
  });

  it("reports an unmappable movement as a problem and writes nothing from the list", () => {
    const out = read("2097-07-06T01:00:00.000Z", [
      interest("2097-07-06", 0.02),
      brokerMovement({ kind: "corporate_action", title: "Evento Corporativo", occurred_on: "2097-07-06", amount: 1, currency: "usd" }),
    ]);
    expect(out.problems[0]).toMatch(/no ledger mapping yet/);
    expect(out.clean).toBe(false);
    expect(interestOn("2097-07-06")).toEqual([]);
  });

  it("recognises a row without its instrument by the cash leg alone, and never guesses between two", () => {
    const dividendRow = brokerMovement({
      kind: "dividend",
      title: "Dividendo",
      occurred_on: "2097-07-03",
      amount: 0.85,
      currency: "usd",
      incomplete: "paying instrument unknown — the crawl could not open its detail view (not among the 10 rendered rows)",
    });
    expect(planRacionalMovements([dividendRow]).planned[0]!.blocked).toMatch(/^paying instrument unknown/);
    const first = seedDividend();
    expect(planRacionalMovements([dividendRow]).planned[0]).toMatchObject({ duplicate_of: first, blocked: null });
    seedDividend(); // a second same-day credit of the same amount: which one would it be?
    expect(planRacionalMovements([dividendRow]).planned[0]!.blocked).toMatch(/^paying instrument unknown/);

    // A buy whose title names no ticker knows only the cash it spent.
    const buy = { ...unopenedBuy, title: "Compra", ticker: null, incomplete: "share count and instrument unknown — the crawl could not open its detail view" };
    expect(planRacionalMovements([buy]).planned[0]!.blocked).toMatch(/^share count and instrument unknown/);
    const existing = seedBuy();
    expect(planRacionalMovements([buy]).planned[0]).toMatchObject({ duplicate_of: existing, blocked: null });
  });
});
