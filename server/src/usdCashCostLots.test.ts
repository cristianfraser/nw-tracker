import { afterEach, describe, expect, it } from "vitest";
import { applyBrokerNotifications } from "./brokerNotificationsApply.js";
import { facturacionUsdRatesForAccount, usdDebtPaymentsForAccount } from "./ccFacturacionUsdRate.js";
import { db } from "./db.js";
import { brokerNotification } from "./test/brokerNotificationFixtures.js";
import { usdOutflowPesoCostByMovement } from "./usdCashCostLots.js";

const FINTUAL_USD_KEY = "import:panel|kind=usd|key=fintual_usd";
const FINTUAL_CLP_KEY = "import:panel|kind=clp|key=fintual_clp";
const PREFIX = "vitest usdCashCostLots";

const createdAccounts: number[] = [];
const createdMovements: number[] = [];
const createdRequests: string[] = [];
const createdFx: string[] = [];
let seq = 0;

function groupId(slug: string): number {
  const row = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(slug) as { id: number } | undefined;
  if (!row) throw new Error(`test DB has no asset group ${slug}`);
  return row.id;
}

function account(name: string, groupSlug: string, importKey: string | null = null): number {
  if (importKey) {
    const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  db.prepare(
    `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
     VALUES (?, ?, 0, datetime('now'), ?)`
  ).run(groupId(groupSlug), `${PREFIX} ${name}`, importKey);
  const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
  createdAccounts.push(id);
  return id;
}

function movement(m: {
  date: string;
  from?: number | null;
  to?: number | null;
  account?: number | null;
  amount: number;
  currency: "clp" | "usd";
  counter_amount?: number | null;
  counter_currency?: "usd" | null;
  flow_kind?: string | null;
  units?: number | null;
}): number {
  const info = db
    .prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, counter_amount,
         counter_currency, occurred_on, note, units_delta, flow_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.account ?? null,
      m.from ?? null,
      m.to ?? null,
      m.amount,
      m.currency,
      m.counter_amount ?? null,
      m.counter_currency ?? null,
      m.date,
      `${PREFIX} ${++seq}`,
      m.units ?? null,
      m.flow_kind ?? null
    );
  const id = Number(info.lastInsertRowid);
  createdMovements.push(id);
  return id;
}

function stampTime(movementId: number, at: string): void {
  db.prepare(
    `INSERT INTO movement_event_times (movement_id, occurred_at, source, message_id) VALUES (?, ?, 'broker_mail', ?)`
  ).run(movementId, new Date(at).toISOString(), `<${PREFIX}-${movementId}>`);
}

function request(o: { at: string; gross: number; net: number }): string {
  const messageId = `<${PREFIX}-req-${++seq}@test>`;
  db.prepare(
    `INSERT INTO broker_withdrawal_requests (message_id, broker, requested_at, subject, currency, gross_amount,
       net_amount, destination_account, due_on)
     VALUES (?, 'fintual', ?, 'Retiro en dólares confirmado', 'usd', ?, ?, '9988776655', ?)`
  ).run(messageId, o.at, o.gross, o.net, o.at.slice(0, 10));
  createdRequests.push(messageId);
  return messageId;
}

function booking(requestId: string, transferId: number | null, feeId: number | null, valueDate: string): void {
  db.prepare(
    `INSERT INTO incoming_wire_bookings (request_message_id, value_date, transfer_movement_id, fee_movement_id)
     VALUES (?, ?, ?, ?)`
  ).run(requestId, valueDate, transferId, feeId);
}

afterEach(() => {
  for (const id of createdRequests.splice(0)) {
    db.prepare(`DELETE FROM incoming_wire_bookings WHERE request_message_id = ?`).run(id);
    db.prepare(`DELETE FROM broker_withdrawal_requests WHERE message_id = ?`).run(id);
  }
  for (const id of createdMovements.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
  for (const date of createdFx.splice(0)) db.prepare(`DELETE FROM fx_daily WHERE date = ?`).run(date);
  for (const id of createdAccounts.splice(0)) {
    db.prepare(`DELETE FROM movements WHERE account_id = ? OR from_account_id = ? OR to_account_id = ?`).run(id, id, id);
    db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  }
});

/** A Fintual dollar withdrawal paid into Santander USD and on to the card (synthetic amounts). */
function realCase(opts: { stampPurchase: boolean }) {
  const fintualUsd = account("Fintual USD", "brokerage_cash__usd", FINTUAL_USD_KEY);
  const fintualClp = account("Fintual CLP", "brokerage_cash__clp");
  const santanderUsd = account("Santander USD", "cash_eqs__usd");
  const stock = account("SOXQ", "brokerage_acciones__spy");
  const card = account("card", "credit_cards__credit_card");
  const firstBuy = movement({
    date: "2097-10-05",
    from: fintualClp,
    to: fintualUsd,
    amount: 900_000,
    currency: "clp",
    counter_amount: 1000,
    counter_currency: "usd",
    flow_kind: "compra_usd_venta_clp",
  });
  if (opts.stampPurchase) stampTime(firstBuy, "2097-10-05T14:31:00Z");
  const req = request({ at: "2097-10-05T22:22:00Z", gross: 950, net: 940 });
  movement({
    date: "2097-10-07",
    from: fintualClp,
    to: fintualUsd,
    amount: 500_000,
    currency: "clp",
    counter_amount: 520,
    counter_currency: "usd",
    flow_kind: "compra_usd_venta_clp",
  });
  const soxq = movement({ date: "2097-10-07", from: fintualUsd, to: stock, amount: 570, currency: "usd", flow_kind: "stock_buy", units: 1 });
  const wire = movement({ date: "2097-10-08", from: fintualUsd, to: santanderUsd, amount: 940, currency: "usd" });
  const fee = movement({ date: "2097-10-08", account: fintualUsd, amount: 10, currency: "usd", flow_kind: "cash_fee" });
  booking(req, wire, fee, "2097-10-08");
  const payment = movement({ date: "2097-10-09", from: santanderUsd, to: card, amount: 940, currency: "usd", flow_kind: "pago_tarjeta" });
  return { card, soxq, wire, fee, payment };
}

describe("usdOutflowPesoCostByMovement", () => {
  it("prices a dollar card payment at the pesos the withdrawal reserved at request time", () => {
    const { card, soxq, fee, payment } = realCase({ stampPurchase: true });
    const reservedClp = (950 * 900_000) / 1000;
    const costs = usdOutflowPesoCostByMovement();
    expect(costs.get(payment)!.usd).toBe(940);
    expect(costs.get(payment)!.clp).toBeCloseTo(reservedClp, 6);
    expect(costs.get(payment)!.lots.map((l) => l.source)).toEqual(["own_transfer"]);
    expect(costs.get(fee)!.clp).toBe(0);
    // The buy two days later spends what the request left of 10-05 plus all of 10-07's dollars.
    expect(costs.get(soxq)!.clp).toBeCloseTo(900_000 - reservedClp + 500_000, 6);

    expect(usdDebtPaymentsForAccount(card)).toEqual([
      { date_iso: "2097-10-09", usd: 940, clp: costs.get(payment)!.clp },
    ]);
    const rates = facturacionUsdRatesForAccount(card, [
      { billing_month: "2097-09", close_date_iso: "2097-09-24", pay_by_iso: "2097-10-10" },
    ]);
    expect(rates.get("2097-09")!.source).toBe("paid");
    expect(rates.get("2097-09")!.clp_per_usd).toBeCloseTo(reservedClp / 940, 6);
  });

  it("refuses a request day whose other events on the account have no time", () => {
    realCase({ stampPurchase: false });
    expect(() => usdOutflowPesoCostByMovement()).toThrow(/has no time/);
  });

  it("keeps reserved dollars from a later buy", () => {
    const fintualUsd = account("Fintual USD", "brokerage_cash__usd", FINTUAL_USD_KEY);
    const fintualClp = account("Fintual CLP", "brokerage_cash__clp");
    const card = account("card", "credit_cards__credit_card");
    const buy = movement({
      date: "2097-11-02",
      from: fintualClp,
      to: fintualUsd,
      amount: 100_000,
      currency: "clp",
      counter_amount: 100,
      counter_currency: "usd",
      flow_kind: "compra_usd_venta_clp",
    });
    stampTime(buy, "2097-11-02T12:00:00Z");
    request({ at: "2097-11-02T15:00:00Z", gross: 100, net: 100 });
    movement({ date: "2097-11-03", from: fintualUsd, to: card, amount: 10, currency: "usd", flow_kind: "pago_tarjeta" });
    expect(() => usdOutflowPesoCostByMovement()).toThrow(/needs US\$10\.00 but only US\$0\.00/);
  });

  it("consumes FIFO without a request", () => {
    const usd = account("USD cash", "cash_eqs__usd");
    const clp = account("CLP cash", "brokerage_cash__clp");
    const card = account("card", "credit_cards__credit_card");
    for (const [date, pesos] of [["2097-12-01", 90_000], ["2097-12-02", 100_000]] as const) {
      movement({ date, from: clp, to: usd, amount: pesos, currency: "clp", counter_amount: 100, counter_currency: "usd", flow_kind: "compra_usd_venta_clp" });
    }
    const payment = movement({ date: "2097-12-03", from: usd, to: card, amount: 150, currency: "usd", flow_kind: "pago_tarjeta" });
    const cost = usdOutflowPesoCostByMovement().get(payment)!;
    expect(cost.clp).toBeCloseTo(140_000, 6);
    expect(cost.lots.map((l) => [l.source, l.usd])).toEqual([["purchase", 100], ["purchase", 50]]);
  });

  it("lets a timeless day's arrivals fund its spending, whatever the ids", () => {
    const usd = account("USD cash", "cash_eqs__usd");
    const clp = account("CLP cash", "brokerage_cash__clp");
    const stock = account("stock", "brokerage_acciones__spy");
    const card = account("card", "credit_cards__credit_card");
    // The buy is written before the wire that funds it, the same day.
    movement({ date: "2097-11-10", from: usd, to: stock, amount: 100, currency: "usd", flow_kind: "stock_buy", units: 1 });
    movement({ date: "2097-11-10", from: clp, to: usd, amount: 95_000, currency: "clp", counter_amount: 100, counter_currency: "usd", flow_kind: "compra_usd_venta_clp" });
    movement({ date: "2097-11-11", from: clp, to: usd, amount: 97_000, currency: "clp", counter_amount: 100, counter_currency: "usd", flow_kind: "compra_usd_venta_clp" });
    const payment = movement({ date: "2097-11-12", from: usd, to: card, amount: 100, currency: "usd", flow_kind: "pago_tarjeta" });
    expect(usdOutflowPesoCostByMovement().get(payment)!.clp).toBeCloseTo(97_000, 6);
  });

  it("values a dollar inflow without pesos at the stored rate of its date", () => {
    const usd = account("USD cash", "cash_eqs__usd");
    const stock = account("stock", "brokerage_acciones__spy");
    const card = account("card", "credit_cards__credit_card");
    db.prepare(`INSERT INTO fx_daily (date, clp_per_usd) VALUES ('2096-01-02', 950)`).run();
    createdFx.push("2096-01-02");
    movement({ date: "2096-01-05", from: stock, to: usd, amount: 50, currency: "usd", flow_kind: "dividend_payout" });
    const payment = movement({ date: "2096-01-06", from: usd, to: card, amount: 50, currency: "usd", flow_kind: "pago_tarjeta" });
    const cost = usdOutflowPesoCostByMovement().get(payment)!;
    expect(cost.clp).toBeCloseTo(47_500, 6);
    expect(cost.lots[0]!.source).toBe("market");
  });

  it("throws on a shortfall", () => {
    const usd = account("USD cash", "cash_eqs__usd");
    const clp = account("CLP cash", "brokerage_cash__clp");
    const card = account("card", "credit_cards__credit_card");
    movement({ date: "2097-12-01", from: clp, to: usd, amount: 90_000, currency: "clp", counter_amount: 100, counter_currency: "usd", flow_kind: "compra_usd_venta_clp" });
    movement({ date: "2097-12-03", from: usd, to: card, amount: 200, currency: "usd", flow_kind: "pago_tarjeta" });
    expect(() => usdOutflowPesoCostByMovement()).toThrow(/needs US\$200\.00 but only US\$100\.00/);
  });
});

describe("broker mail event times", () => {
  it("stamps the movement a re-sent mail matches, and never overwrites a stamp", () => {
    const fintualUsd = account("Fintual USD", "brokerage_cash__usd", FINTUAL_USD_KEY);
    const fintualClp = account("Fintual CLP", "cash_eqs__cash_savings", FINTUAL_CLP_KEY);
    // Already in the ledger (booked before stamps existed).
    const existing = movement({
      date: "2097-10-05",
      from: fintualClp,
      to: fintualUsd,
      amount: 900_000,
      currency: "clp",
      counter_amount: 1000,
      counter_currency: "usd",
      flow_kind: "compra_usd_venta_clp",
    });
    const mail = (at: string) =>
      brokerNotification({
        kind: "wallet_funded",
        subject: "Compraste dólares",
        occurred_at: at,
        amount: 1000,
        clp_amount: 900_000,
        currency: "usd",
      });
    const stampOf = () =>
      (db.prepare(`SELECT occurred_at, source FROM movement_event_times WHERE movement_id = ?`).get(existing) as
        | { occurred_at: string; source: string }
        | undefined);

    const first = applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [mail("2097-10-05T14:31:00Z")] });
    expect(first.written).toBe(0);
    expect(first.event_times_stamped).toBe(1);
    expect(stampOf()).toEqual({ occurred_at: "2097-10-05T14:31:00.000Z", source: "broker_mail" });

    const again = applyBrokerNotifications({ broker: "fintual", apply: true, notifications: [mail("2097-10-05T15:00:00Z")] });
    expect(again.event_times_stamped).toBe(0);
    expect(stampOf()!.occurred_at).toBe("2097-10-05T14:31:00.000Z");
  });
});
