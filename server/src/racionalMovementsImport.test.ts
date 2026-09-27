import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import {
  applyRacionalDividendDetails,
  markDuplicates,
  nextRacionalImportState,
  planRacionalDividendDetails,
  planRacionalMovement,
  planRacionalMovementsFile,
  racionalComisionCrawlDue,
  readRacionalImportState,
  runRacionalImport,
  writeRacionalImportState,
} from "./racionalMovementsImport.js";
import { getMovementDividendDetail } from "./movementDividendDetails.js";
import { racionalListRowKey, racionalRowToMovement } from "./racionalMovements.js";
import type { RacionalPlannedMovement } from "./racionalMovementsImport.js";

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
    const source = racionalRowToMovement({
      title: "Compra VEA",
      amount: `US$${amount.toFixed(2).replace(".", ",")}`,
      occurred_on: day,
      kind_class: "buy",
      detail: `Orden #TEST Recibiste 1,00000000 acciones de Vanguard (VEA), a un valor de US$1,00 por acción.`,
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
      for (const [title, kindClass] of [
        ["Depósito", "contribution"],
        ["Retiro", undefined],
      ] as const) {
        const planned = planRacionalMovement(
          racionalRowToMovement({
            title,
            amount: "$1.000.000",
            occurred_on: "2026-07-02",
            kind_class: kindClass,
          })
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
    racionalRowToMovement({
      title: "Comisión",
      amount: "$2.335",
      occurred_on: "2026-08-18",
      kind_class: "commissions",
    });

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
describe("racional staged files — incomplete rows, file isolation, watermark", () => {
  const TICKER = "VTRACBUY";
  let usd: { id: number; cleanup: () => void };
  let equity: number;
  let dir: string;

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
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "racional-import-"));
  });

  afterEach(() => {
    db.prepare(
      `DELETE FROM movements WHERE occurred_on LIKE '2097-07-%'
         AND (account_id IN (?, ?) OR from_account_id IN (?, ?) OR to_account_id IN (?, ?))`
    ).run(usd.id, equity, usd.id, equity, usd.id, equity);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(equity);
    usd.cleanup();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A buy the crawl listed but could not open: no id, no detail, so no share count. */
  const unopenedBuy = {
    title: `Compra ${TICKER}`,
    amount: "US$1.234,56",
    day: "01/07",
    occurred_on: "2097-07-01",
    kind_class: "buy",
    detail_status: "unopened",
    detail_error: "not among the 10 rendered rows",
  };
  const interest = (ymd: string, amount: string) => ({
    title: "Intereses",
    amount,
    day: `${ymd.slice(8)}/${ymd.slice(5, 7)}`,
    occurred_on: ymd,
    kind_class: null,
  });

  function stage(name: string, content: unknown): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(content));
    return file;
  }

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

  it("plans an unopened buy the ledger already holds as already present, without throwing", () => {
    const existing = seedBuy();
    const planned = planRacionalMovementsFile(stage("movements-2097-07-02T01-00-00.json", [unopenedBuy]));
    expect(planned.planned).toHaveLength(1);
    expect(planned.planned[0]).toMatchObject({ duplicate_of: existing, blocked: null, conflict: null });
    expect(planned.planned[0]!.source.incomplete).toMatch(/could not open its detail view \(not among the 10 rendered rows\)/);
  });

  it("fails only the file that would have to write it — later files and the dividends pass still run", () => {
    stage("movements-2097-07-02T01-00-00.json", [unopenedBuy, interest("2097-07-01", "US$0,05")]);
    // A malformed file (an unmapped kind) is isolated the same way.
    stage("movements-2097-07-02T12-00-00.json", [{ title: "Algo Nuevo", amount: "US$1,00", day: "02/07", occurred_on: "2097-07-02" }]);
    stage("movements-2097-07-03T01-00-00.json", [interest("2097-07-02", "US$0,07")]);
    const dividend = seedDividend();
    stage("dividends-2097-07-03T01-00-00.json", {
      dividends: [
        {
          id: `div_NI.vitest-import_${TICKER}_2097-07-03T12:00:00.000Z`,
          assetId: TICKER,
          DIV: 1,
          DIVTAX: -0.15,
          amount: 0.85,
          amountUSD: 0.85,
          executionDate: "2097-07-03T12:00:00.000Z",
          isInterest: false,
          isRebateInterest: false,
          isUSDDividend: true,
        },
      ],
    });

    const lines: string[] = [];
    const summary = runRacionalImport({
      dir,
      statePath: path.join(dir, "state.json"),
      apply: true,
      nowIso: "2097-07-03T02:00:00.000Z",
      log: (line) => lines.push(line),
    });

    // Both failures name their file (and the row), and fail the step.
    expect(summary.failures).toHaveLength(2);
    expect(summary.failures[0]).toContain("movements-2097-07-02T01-00-00.json");
    expect(summary.failures[0]).toContain(`«Compra ${TICKER}»`);
    expect(summary.failures[0]).toMatch(/share count unknown .* no ledger movement matches it/);
    expect(summary.failures[1]).toMatch(/movements-2097-07-02T12-00-00\.json: Unmapped Racional movement kind "Algo Nuevo"/);
    expect(lines.join("\n")).toMatch(/NOT imported: nothing from this file is written/);
    // Nothing from the failed file is written — not even its writable interest row…
    expect(interestOn("2097-07-01")).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM movements WHERE to_account_id = ? AND occurred_on = '2097-07-01'`).get(equity)).toEqual({ n: 0 });
    // …while the later file is applied and the dividends pass writes its breakdown.
    expect(interestOn("2097-07-02")).toEqual([{ amount: 0.07 }]);
    expect(getMovementDividendDetail(dividend)).toMatchObject({ gross_amount: 1, withholding_amount: 0.15, source: "racional_api" });
    // The watermark is the first row of the newest file that imported cleanly — in the crawler's
    // key format — and a run with a failure answers no e-mail nudge.
    expect(summary.state).toMatchObject({
      last_row_key: "2097-07-02|Intereses|US$0,07",
      watermark_file: "movements-2097-07-03T01-00-00.json",
      clean_crawl_at: null,
    });
    expect(readRacionalImportState(path.join(dir, "state.json"))).toEqual(summary.state);
  });

  it("never moves the watermark back, and records the crawl a clean run covered", () => {
    const statePath = path.join(dir, "state.json");
    const newer = {
      last_row_key: "2097-07-09|buy|US$9,99",
      last_movement_id: "vitest_2097-07-09T15:00:00.000Z_9.99",
      last_occurred_at: "2097-07-09T15:00:00.000Z",
      watermark_file: "movements-2097-07-09T01-00-00.json",
      clean_crawl_at: null,
      updated_at: "2097-07-09T02:00:00.000Z",
    };
    writeRacionalImportState(newer, statePath);
    seedBuy(); // the unopened buy is in the ledger: every file below is clean
    stage("movements-2097-07-02T01-00-00.json", [unopenedBuy]);
    stage("movements-2097-07-03T01-00-00.json", []); // a quiet crawl — it read the list, found nothing new

    const summary = runRacionalImport({ dir, statePath, apply: true, nowIso: "2097-07-10T00:00:00.000Z", log: () => {} });
    expect(summary.failures).toEqual([]);
    expect(readRacionalImportState(statePath)).toEqual({
      ...newer,
      clean_crawl_at: "2097-07-03T01:00:00.000Z",
      updated_at: "2097-07-10T00:00:00.000Z",
    });
  });

  it("moves both marks forward only", () => {
    const candidate = {
      file: "movements-2097-07-03T01-00-00.json",
      row_key: "2097-07-03|buy|US$1,00",
      movement_id: "m3",
      occurred_at: "2097-07-03T00:00:00.000Z",
    };
    // A state from before list keys (a route id, no file) takes any candidate.
    const legacy = { last_movement_id: "vitest_2097-07-01T16:00:00.000Z_1", last_occurred_at: "2097-07-01T16:00:00.000Z", updated_at: "t0" };
    expect(nextRacionalImportState(legacy, { watermark: candidate, clean_crawl_at: null }, "t1")).toMatchObject({
      last_row_key: candidate.row_key,
      watermark_file: candidate.file,
      clean_crawl_at: null,
    });
    const current = nextRacionalImportState(null, { watermark: candidate, clean_crawl_at: "2097-07-03T01:00:00.000Z" }, "t1")!;
    // The same crawl again, or older ones: nothing to write.
    expect(nextRacionalImportState(current, { watermark: candidate, clean_crawl_at: "2097-07-03T01:00:00.000Z" }, "t2")).toBeNull();
    expect(
      nextRacionalImportState(
        current,
        { watermark: { ...candidate, file: "movements-2097-07-02T01-00-00.json" }, clean_crawl_at: "2097-07-02T01:00:00.000Z" },
        "t2"
      )
    ).toBeNull();
    // A newer crawl moves the watermark and keeps the recorded coverage.
    expect(
      nextRacionalImportState(current, { watermark: { ...candidate, file: "movements-2097-07-04T01-00-00.json", row_key: "k4" }, clean_crawl_at: null }, "t2")
    ).toMatchObject({ last_row_key: "k4", clean_crawl_at: "2097-07-03T01:00:00.000Z", updated_at: "t2" });
  });

  it("recognises a row without its instrument by the cash leg alone, and never guesses between two", () => {
    const file = stage("movements-2097-07-04T01-00-00.json", [
      {
        title: "Dividendo",
        amount: "US$0,85",
        day: "03/07",
        occurred_on: "2097-07-03",
        kind_class: "dividends",
        detail_status: "unopened",
        detail_error: "not among the 10 rendered rows",
      },
    ]);
    expect(planRacionalMovementsFile(file).planned[0]!.blocked).toMatch(/^paying instrument unknown/);
    const first = seedDividend();
    expect(planRacionalMovementsFile(file).planned[0]).toMatchObject({ duplicate_of: first, blocked: null });
    seedDividend(); // a second same-day credit of the same amount: which one would it be?
    expect(planRacionalMovementsFile(file).planned[0]!.blocked).toMatch(/^paying instrument unknown/);

    // A buy whose title names no ticker knows only the cash it spent.
    const buy = stage("movements-2097-07-05T01-00-00.json", [{ ...unopenedBuy, title: "Compra" }]);
    expect(planRacionalMovementsFile(buy).planned[0]!.blocked).toMatch(/^share count and instrument unknown/);
    const existing = seedBuy();
    expect(planRacionalMovementsFile(buy).planned[0]).toMatchObject({ duplicate_of: existing, blocked: null });
  });

  it("writes the crawler's own list key as the watermark — the formula is textually the crawler's", () => {
    // Staged rows exactly as the crawler writes them.
    expect(
      racionalListRowKey({ title: "Compra VTSYN", amount: "US$797,01", day: "22/09", occurred_on: "2097-09-22", kind_class: "buy" })
    ).toBe("2097-09-22|buy|US$797,01");
    expect(
      racionalListRowKey({ title: "Compra VTSYN", amount: "US$1.346,17", day: "01/07", occurred_on: null, kind_class: null })
    ).toBe("01/07|Compra VTSYN|US$1.346,17");
    expect(() => racionalListRowKey({ title: "Compra VTSYN", amount: "US$1,00" })).toThrow(/no list identity/);

    // The fetcher compares its rendered rows with this key using `rowKey` in the scraper, which
    // cannot import the server: the two return lines must stay identical.
    const returnLine = (file: URL, fn: string): string => {
      const m = new RegExp(`function ${fn}\\([^)]*\\): string \\{[\\s\\S]*?\\n  (return [^\\n]+)\\n\\}`).exec(
        fs.readFileSync(file, "utf8")
      );
      if (!m) throw new Error(`no ${fn} in ${file.pathname}`);
      return m[1]!;
    };
    expect(returnLine(new URL("../../scraper/src/racional/steps.ts", import.meta.url), "rowKey")).toBe(
      returnLine(new URL("./racionalMovements.ts", import.meta.url), "racionalListRowKey")
    );
  });
});
