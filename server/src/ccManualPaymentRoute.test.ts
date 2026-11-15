import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CC_MANUAL_PAYMENT_TASK, createIngestClient } from "nw-tracker-contracts";
import { clearAggregationCache } from "./cacheRegistry.js";
import { createPanelAccount } from "./createPanelAccount.js";
import { db } from "./db.js";
import { registerIngestRoutes } from "./routes/ingest.js";
import { deleteTempCardMaster } from "./test/tempCardMaster.js";

/**
 * `POST /api/ingest/tasks/cc_manual_payment` takes any currency the card's issuer declares
 * (wave 9 `ut-currency-seams`): a euro payment on a card that bills in euros (issuer `euronova`)
 * is recorded over HTTP, and a currency the issuer does not bill in is refused with
 * `requireCardCurrency`'s own message as a 4xx.
 */
describe("a manual card payment over HTTP in the issuer's currency", () => {
  const NOTE = "vitest-manual-payment-route-eur";
  const CARD_KEY = `credit_card_master|euronova|${NOTE}`;
  const CASH_SLUG = "vitest_manual_payment_route_cash_eur";
  const PAID_ON = "2039-04-12";
  const RATE_DAYS = ["2039-01-01", "2039-04-11"];
  let server: Server;
  let base = "";
  let cardId = 0;
  let cashId = 0;
  let batchFloor = 0;

  function removeFixture(): void {
    const card = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(CARD_KEY) as { id: number } | undefined;
    db.prepare(`DELETE FROM movements WHERE note = ?`).run(NOTE);
    if (card) {
      db.prepare(`DELETE FROM movements WHERE to_account_id = ? OR from_account_id = ?`).run(card.id, card.id);
      deleteTempCardMaster(card.id);
    }
    const groups = db.prepare(`SELECT id FROM asset_groups WHERE slug LIKE ?`).all(`%${CASH_SLUG}%`) as { id: number }[];
    for (const g of groups) {
      db.prepare(`DELETE FROM accounts WHERE asset_group_id = ?`).run(g.id);
      db.prepare(`DELETE FROM asset_groups WHERE id = ?`).run(g.id);
    }
    for (const date of RATE_DAYS) db.prepare(`DELETE FROM eur_daily WHERE date = ?`).run(date);
    clearAggregationCache();
  }

  beforeAll(async () => {
    removeFixture();
    batchFloor = (db.prepare(`SELECT COALESCE(MAX(id), 0) AS id FROM import_batches`).get() as { id: number }).id;
    const leaf = db
      .prepare(`SELECT id FROM asset_groups WHERE slug LIKE '%__credit_card' OR slug LIKE 'credit_cards__%' LIMIT 1`)
      .get() as { id: number };
    cardId = Number(
      db
        .prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
        .run(leaf.id, "Vitest · manual payment route card eur", NOTE, CARD_KEY).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO credit_card_account_config (account_id, card_last4, billing_cycle_start_day, billing_cycle_end_day, issuer)
       VALUES (?, '4472', 6, 5, 'euronova')`
    ).run(cardId);
    cashId = createPanelAccount({
      account: {
        account_type: "foreign_cash",
        currency: "eur",
        name: "Vitest manual payment route cash eur",
        bucket_slug: "cash_savings",
        category_slug: CASH_SLUG,
        exclude_from_group_totals: true,
      },
    }).account_id;
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note, flow_kind) VALUES (?, 500, 'eur', '2039-01-05', ?, 'deposit')`
    ).run(cashId, NOTE);
    for (const date of RATE_DAYS) {
      db.prepare(`INSERT OR REPLACE INTO eur_daily (date, clp_per_eur) VALUES (?, 1020)`).run(date);
    }
    clearAggregationCache();

    const app = express();
    app.use(express.json());
    registerIngestRoutes(app, { auth: { token: null, allowRemote: false, demoMode: false } });
    server = await new Promise<Server>((resolve) => {
      const s: Server = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    removeFixture();
    db.prepare(`DELETE FROM import_batches WHERE id > ? AND kind = 'cc_manual_payment'`).run(batchFloor);
  });

  const post = (body: unknown) =>
    fetch(`${base}/api/ingest/tasks/${CC_MANUAL_PAYMENT_TASK}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("records a euro payment through the typed client and plants the card's euro line", async () => {
    const client = createIngestClient({ baseUrl: base, feederId: "vitest" });
    const result = await client.recordManualCardPayment({
      from_account_id: cashId,
      card_account_id: cardId,
      amount: 23.4,
      currency: "eur",
      paid_on: PAID_ON,
      note: NOTE,
    });
    expect(result).toMatchObject({ status: "recorded", card_line: "planted" });
    const transfer = db
      .prepare(`SELECT from_account_id, to_account_id, amount, currency, flow_kind FROM movements WHERE id = ?`)
      .get(result.transfer_movement_id);
    expect(transfer).toEqual({ from_account_id: cashId, to_account_id: cardId, amount: 23.4, currency: "eur", flow_kind: "pago_tarjeta" });
    const line = db.prepare(`SELECT amount, currency, kind FROM cc_statement_lines WHERE id = ?`).get(result.planted_line_id);
    expect(line).toEqual({ amount: -23.4, currency: "eur", kind: "card_payment" });
    const stored = db.prepare(`SELECT currency, amount FROM cc_manual_payments WHERE id = ?`).get(result.manual_payment_id);
    expect(stored).toEqual({ currency: "eur", amount: 23.4 });
  });

  it("refuses a currency the issuer does not bill in with requireCardCurrency's message, as a 4xx", async () => {
    // The isolated Santander fixture master (vitestDbSeed.ts): its issuer bills in pesos and dollars.
    const santander = db
      .prepare(`SELECT id FROM accounts WHERE import_key = 'credit_card_master|santander|vitest-fixture'`)
      .get() as { id: number };
    const before = (db.prepare(`SELECT COUNT(*) AS n FROM cc_manual_payments`).get() as { n: number }).n;
    const res = await post({ from_account_id: cashId, card_account_id: santander.id, amount: 5, currency: "eur", paid_on: PAID_ON });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("unsupported_currency");
    expect(body.message).toBe("manual card payment: EUR is not a currency the card's issuer (santander) bills in");
    expect((db.prepare(`SELECT COUNT(*) AS n FROM cc_manual_payments`).get() as { n: number }).n).toBe(before);
  });

  it("refuses a currency the app does not know as a 4xx", async () => {
    const res = await post({ from_account_id: cashId, card_account_id: cardId, amount: 5, currency: "xqz", paid_on: PAID_ON });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "unknown_currency" });
  });
});
