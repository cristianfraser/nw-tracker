import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MerchantPurchaseDocument } from "nw-tracker-contracts";
import { importCcWebPasteLines } from "./accountImports.js";
import { resolveMasterAccountIdForImportCardLast4 } from "./ccConsolidatedCards.js";
import { resolveCcExpensePurchaseKey } from "./ccExpenseCategories.js";
import { db } from "./db.js";
import { APP_STORE_MERCHANT, matchMerchantExpenseNotes, onBillingCycle, shortAppLabel } from "./merchantExpenseNotes.js";
import { applyMerchantPurchaseDocument } from "./merchantPurchaseDocumentApply.js";
import { overrideFxDaily } from "./test/fxDailyFixture.js";
import { snapshotTables } from "./test/snapshotTables.js";
import {
  ensureVitestCreditCardFixtures,
  getVitestSantanderCcMasterAccountId,
  wipeVitestCcFixtureData,
} from "./test/vitestDbSeed.js";

/**
 * App Store charges on the isolated vitest master (card ·0000). The test DB is synthetic, so its
 * App Store documents are this file's own. Dates sit in 2037, past every real fx row, so the one
 * overridden rate prices the dollar-only lines.
 */
const MERCHANT = APP_STORE_MERCHANT;
/** Every 2037 charge is past the receipt window by then. */
const TODAY = "2038-06-01";

/** The funnel test pastes onto the synthetic preset's master ·4321; restore its tables after. */
const restoreCcTables = snapshotTables([
  "cc_statements",
  "cc_statement_lines",
  "cc_expense_line_categories",
  "cc_expense_purchase_notes",
  "cc_billing_month_balances",
  "valuations",
  "import_batches",
]);
const FX = 1000;

describe("merchantExpenseNotes", () => {
  let accountId = 0;
  let statementId = 0;
  let seq = 0;
  let restoreFx: () => void = () => {};

  function line(date: string, opts: { pesos?: number; usd?: number; merchant?: string }): string {
    seq += 1;
    const pr = `vitest-appstore|${seq}`;
    db.prepare(
      `INSERT INTO cc_statement_lines (
         statement_id, transaction_date, merchant, amount_clp, amount_usd, amount_orig, orig_currency,
         installment_flag, dedupe_key, parser_row_id, raw_line
       ) VALUES (?, ?, ?, 0, ?, ?, ?, 0, ?, ?, 'vitest')`
    ).run(
      statementId,
      date,
      opts.merchant ?? "APPLE.COM/BILL",
      opts.usd ?? (opts.pesos != null ? opts.pesos / FX : null),
      opts.pesos ?? null,
      opts.pesos != null ? "clp" : null,
      pr,
      pr
    );
    return `line-pr:${pr}`;
  }

  const note = (key: string): string | null =>
    (db.prepare(`SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`).get(accountId, key) as
      | { notes: string }
      | undefined)?.notes ?? null;

  const receipt = (issuedOn: string, items: { app: string | null; product?: string | null; amount: number; renews?: boolean; icon?: string }[]): MerchantPurchaseDocument => ({
    type: "receipt",
    issued_on: issuedOn,
    order_id: null,
    card_last4: "0000",
    total: { amount: items.reduce((s, i) => s + i.amount, 0), currency: "clp" },
    items: items.map((i) => ({
      app: i.app,
      product: i.product ?? null,
      amount: i.amount,
      renews: i.renews ?? false,
      period: i.renews ? "month" : null,
      icon_url: i.icon ? `https://is1-ssl.mzstatic.com/image/thumb/${i.icon}/AppIcon.png/128x128bb.png` : null,
    })),
  });

  let ref = 0;
  const send = (...documents: MerchantPurchaseDocument[]) =>
    applyMerchantPurchaseDocument({ merchant: MERCHANT, documents }, `<vitest-${++ref}@appstore>`, { today: TODAY });

  beforeAll(() => {
    ensureVitestCreditCardFixtures();
    const id = getVitestSantanderCcMasterAccountId();
    if (id == null) throw new Error("vitest CC fixture master missing (NW_TRACKER_TEST_DB unset?)");
    accountId = id;
    restoreFx = overrideFxDaily([["2037-01-01", FX]]);
  });

  beforeEach(() => {
    wipeVitestCcFixtureData();
    db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE purchase_key LIKE 'line-pr:vitest-appstore|%'`).run();
    db.prepare(`DELETE FROM merchant_document_sources WHERE merchant = ?`).run(MERCHANT);
    statementId = Number(
      db
        .prepare(
          `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, card_last4, layout, currency)
           VALUES (?, 'INTL', '2037-12-20 estado de cuenta tarjeta usd 0000.pdf', '20/12/2037', '0000', 'compact', 'usd')`
        )
        .run(accountId).lastInsertRowid
    );
  });

  afterAll(() => {
    db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE purchase_key LIKE 'line-pr:vitest-appstore|%'`).run();
    db.prepare(`DELETE FROM merchant_document_sources WHERE merchant = ?`).run(MERCHANT);
    wipeVitestCcFixtureData();
    restoreFx();
    restoreCcTables();
  });

  it("labels an app by its name before the tagline", () => {
    expect(shortAppLabel("Example Chat - Meet People")).toBe("example chat");
    expect(shortAppLabel("Example Hikes: trails")).toBe("example hikes");
    expect(shortAppLabel("Example TV+ (Automatic Renewal)")).toBe("example tv+");
  });

  it("knows a billing cycle by its anchor and period", () => {
    expect(onBillingCycle("2037-03-26", "2037-01-24", "month")).toBe(true);
    expect(onBillingCycle("2037-03-10", "2037-01-24", "month")).toBe(false);
    expect(onBillingCycle("2037-04-24", "2037-01-24", "quarter")).toBe(true);
    expect(onBillingCycle("2037-03-24", "2037-01-24", "quarter")).toBe(false);
    expect(onBillingCycle("2037-01-22", "2037-01-01", "week")).toBe(true);
    expect(onBillingCycle("2037-01-25", "2037-01-01", "week")).toBe(false);
  });

  it("names the receipt's app on its charge — pesos to the peso, or dollars within 4% — and leaves other charges alone", () => {
    const pesos = line("2037-02-11", { pesos: 12990 });
    const dollars = line("2037-02-13", { usd: 5.1 }); // 5.100 pesos vs a 4.990 receipt: 2,2%
    const unrelated = line("2037-02-12", { pesos: 3300 });
    const result = send(receipt("2037-02-10", [{ app: "Example Chat - Meet People", product: "Boost", amount: 12990 }]));
    expect(result.status).toBe("applied");
    send(receipt("2037-02-12", [{ app: "Example Game: Towers", product: "Gems", amount: 4990 }]));
    expect(note(pesos)).toBe("example chat");
    expect(note(dollars)).toBe("example game");
    expect(note(unrelated)).toBeNull();
  });

  it("reuses an existing note the app's name starts with", () => {
    const old = line("2037-02-01", { pesos: 6000 });
    db.prepare(`INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, 'example')`).run(accountId, old);
    const k = line("2037-02-16", { pesos: 6100 });
    send(receipt("2037-02-15", [{ app: "Example Dating App: Meet", amount: 6100 }]));
    expect(note(k)).toBe("example");
  });

  it("pairs each receipt with one charge, a charge on or after the receipt first", () => {
    const before = line("2037-03-04", { pesos: 7000 });
    const after = line("2037-03-06", { pesos: 7000 });
    send(receipt("2037-03-05", [{ app: "Example Chat", amount: 7000 }]));
    expect(note(after)).toBe("example chat");
    expect(note(before)).toBeNull();
  });

  it("never overwrites a note, and a rerun writes nothing", () => {
    const k = line("2037-04-02", { pesos: 9000 });
    db.prepare(`INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, 'mine')`).run(accountId, k);
    send(receipt("2037-04-01", [{ app: "Example Chat", amount: 9000 }]));
    expect(note(k)).toBe("mine");
    expect(matchMerchantExpenseNotes({ apply: true, merchant: MERCHANT, today: TODAY }).notes_written).toEqual([]);
  });

  it("takes a product-only item's app from another receipt with the same artwork, else reports it", () => {
    const named = line("2037-05-03", { pesos: 2000 });
    const productOnly = line("2037-05-11", { pesos: 7190 });
    const unknown = line("2037-05-20", { pesos: 3500 });
    send(receipt("2037-05-02", [{ app: "Example Chat", product: "Boost", amount: 2000, icon: "a/b/chat" }]));
    send(receipt("2037-05-10", [{ app: null, product: "1 Boost", amount: 7190, icon: "a/b/chat" }]));
    const last = send(receipt("2037-05-19", [{ app: null, product: "Gold Pass", amount: 3500, icon: "a/b/other" }]));
    expect(note(named)).toBe("example chat");
    expect(note(productOnly)).toBe("example chat");
    expect(note(unknown)).toBeNull();
    expect(last.status === "applied" && last.details.unresolved).toEqual([{ issued_on: "2037-05-19", products: ["Gold Pass"] }]);
  });

  it("names a renewal with no receipt from the subscription's cycle; two apps on it make a guess", () => {
    const first = line("2037-01-25", { pesos: 4490 });
    const renewal = line("2037-04-26", { usd: 4.5 }); // dollars only, 4.500 pesos ≈ 4.490
    const offCycle = line("2037-04-10", { pesos: 4490 });
    send(receipt("2037-01-24", [{ app: "Example Music", product: "Membership", amount: 4490, renews: true }]));
    expect(note(first)).toBe("example music");
    expect(note(renewal)).toBe("example music");
    expect(note(offCycle)).toBeNull();

    // Another app at the same price, billing on the same day of the month.
    const both = line("2037-07-25", { pesos: 4490 });
    send({
      type: "subscription_notice",
      notice: "confirmed",
      mailed_on: "2037-06-01",
      app: "Example Radio",
      plan: "Plus",
      price: { amount: 4490, currency: "clp" },
      period: "month",
      purchased_on: "2037-06-25",
      next_charge_on: null,
      expires_on: null,
      card_last4: "0000",
    });
    // Example Radio's anchor (30 days) is nearer than Example Music's charges (90 days).
    expect(note(both)).toBe("guess: example radio");
  });

  it("takes a new price from the day it starts, and carries a hand note to the next month's charge", () => {
    const early = line("2037-07-24", { pesos: 4990 });
    const raised = line("2037-08-24", { pesos: 4990 });
    send({
      type: "subscription_notice",
      notice: "price_increase",
      mailed_on: "2037-07-28",
      app: "Example Music",
      plan: "Individual (1 month)",
      price: { amount: 4990, currency: "clp" },
      period: "month",
      purchased_on: null,
      next_charge_on: "2037-08-24",
      expires_on: null,
      card_last4: null,
    });
    expect(note(early)).toBeNull();
    expect(note(raised)).toBe("example music");

    const handNoted = line("2037-09-03", { pesos: 3300 });
    db.prepare(`INSERT INTO cc_expense_purchase_notes (account_id, purchase_key, notes) VALUES (?, ?, 'example tv')`).run(accountId, handNoted);
    const next = line("2037-10-04", { pesos: 3300 });
    expect(matchMerchantExpenseNotes({ apply: true, merchant: MERCHANT, today: TODAY }).notes_written.map((n) => n.basis)).toEqual(["monthly run"]);
    expect(note(next)).toBe("example tv");
  });

  it("waits out the receipt window before a cadence note, and never runs a month from a one-off purchase", () => {
    send(receipt("2037-01-24", [{ app: "Example Music", amount: 4490, renews: true }]));
    const anchor = line("2037-01-25", { pesos: 4490 });
    const recent = line("2037-02-25", { pesos: 4490 });
    expect(matchMerchantExpenseNotes({ apply: true, merchant: MERCHANT, today: "2037-02-28" }).notes_written.map((n) => n.date)).toEqual(["2037-01-25"]);
    expect(note(anchor)).toBe("example music");
    expect(note(recent)).toBeNull();
    expect(matchMerchantExpenseNotes({ apply: true, merchant: MERCHANT, today: "2037-03-03" }).notes_written.map((n) => n.date)).toEqual(["2037-02-25"]);

    const boost = line("2037-03-11", { pesos: 7000 });
    send(receipt("2037-03-10", [{ app: "Example Chat", product: "Boost", amount: 7000 }]));
    const nextMonth = line("2037-04-11", { pesos: 7000 });
    matchMerchantExpenseNotes({ apply: true, merchant: MERCHANT, today: TODAY });
    expect(note(boost)).toBe("example chat");
    expect(note(nextMonth)).toBeNull();
  });

  it("names the charge when the card feed brings it after the receipt", () => {
    // The paste path resolves the card from its master identity, which the vitest fixture lacks.
    const master = resolveMasterAccountIdForImportCardLast4("4321");
    if (master == null) throw new Error("synthetic preset master ·4321 missing from the test DB");
    const doc = receipt("2037-02-20", [{ app: "Example Chat - Meet People", product: "Boost", amount: 13500 }]);
    send({ ...doc, card_last4: "4321" });
    // Santander web pastes carry charges negative; dollars only, as the feed lists them.
    const res = importCcWebPasteLines(master, {
      lines: [{ transaction_date: "2037-02-21", merchant: "APPLE.COM/BILL", amount_clp: 0, amount_usd: -13.5, currency: "usd", raw_line: "vitest apple paste" }],
      errors: [],
    });
    expect(res.inserted).toBe(1);
    const lineId = (
      db.prepare(`SELECT id FROM cc_statement_lines WHERE raw_line = 'vitest apple paste'`).get() as { id: number }
    ).id;
    const notes = db
      .prepare(`SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`)
      .get(master, resolveCcExpensePurchaseKey(lineId)) as { notes: string } | undefined;
    expect(notes?.notes).toBe("example chat");
  });

  it("stores a source once: a resend is a duplicate, a different payload a conflict", () => {
    const doc = receipt("2037-11-01", [{ app: "Example Chat", amount: 1000 }]);
    const payload = { merchant: MERCHANT, documents: [doc] };
    expect(applyMerchantPurchaseDocument(payload, "<vitest-same@appstore>").status).toBe("applied");
    expect(applyMerchantPurchaseDocument(payload, "<vitest-same@appstore>").status).toBe("duplicate");
    const changed = { merchant: MERCHANT, documents: [receipt("2037-11-01", [{ app: "Example Chat", amount: 2000 }])] };
    expect(applyMerchantPurchaseDocument(changed, "<vitest-same@appstore>")).toMatchObject({ status: "conflict" });
  });
});
