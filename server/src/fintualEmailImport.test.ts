import { afterEach, describe, expect, it } from "vitest";
import { db } from "./db.js";
import { classifyBrokerEmail } from "./brokerEmailParse.js";
import {
  applyFintualEmailMovements,
  markFintualDuplicates,
  pairedDividendTicker,
  planFintualEmailBatch,
  tickerFromFundName,
  type FintualPlannedMovement,
} from "./fintualEmailImport.js";
import { checkingAccountId } from "./checkingCartolaImport.js";

const FINTUAL = "hola@fintual.com";

/** The real 2026-08-05 SPY pair — the movements this whole connector was built to capture. */
const DIVIDEND = {
  sender: FINTUAL,
  subject: "Recibiste un dividendo de SPY por 1,67 dólares",
  date: "2026-08-05T06:07:41Z",
};
const REINVEST = {
  sender: FINTUAL,
  subject:
    "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&P 500 ETF Trust",
  date: "2026-08-05T13:33:15Z",
};

describe("fintualEmailImport", () => {
  const created: number[] = [];
  const createdAccounts: number[] = [];

  afterEach(() => {
    for (const id of created.splice(0)) db.prepare(`DELETE FROM movements WHERE id = ?`).run(id);
    for (const id of createdAccounts.splice(0)) db.prepare(`DELETE FROM accounts WHERE id = ?`).run(id);
  });

  /** The synthetic test DB has neither position; create what the mapping needs. */
  function seedFintualAccounts(): { spy: number; cash: number } | null {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return null;
    const mk = (name: string, ticker: string | null, importKey: string | null): number => {
      db.prepare(
        `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, equity_ticker, import_key)
         VALUES (?, ?, 0, datetime('now'), ?, ?)`
      ).run(group.id, name, ticker, importKey);
      const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      createdAccounts.push(id);
      return id;
    };
    return {
      spy: mk("vitest SPY", "SPY", null),
      cash: mk("vitest Fintual USD", null, "import:panel|kind=usd|key=fintual_usd"),
    };
  }

  it("resolves a reinvestment's holding by pairing it with its dividend", () => {
    // The purchase subject names the fund, never the ticker; the dividend names the ticker.
    // Same amount, same day = the DRIP pair, which identifies the holding with no lookup table.
    const events = [classifyBrokerEmail(DIVIDEND), classifyBrokerEmail(REINVEST)];
    expect(events[1]!.ticker).toBeNull();
    expect(pairedDividendTicker(events[1]!, events)).toBe("SPY");
  });

  it("falls back to the fund-name map for an ordinary purchase", () => {
    // No dividend to pair with — e.g. "Invertiste US $2.237,19 … acciones de Linde plc".
    expect(tickerFromFundName("Invertiste US $2.237,19 dólares en 4,16 acciones de Linde plc")).toBe("LIN");
    expect(tickerFromFundName("… acciones de State Street SPDR S&P 500 ETF Trust")).toBe("SPY");
    expect(tickerFromFundName("… acciones de Some Brand New Fund")).toBeNull();
  });

  it("plans the SPY pair as the ledger's own DRIP shape", () => {
    const seeded = seedFintualAccounts();
    if (!seeded) return;
    const planned = planFintualEmailBatch([
      classifyBrokerEmail(DIVIDEND),
      classifyBrokerEmail(REINVEST),
    ]);
    expect(planned).toHaveLength(2);
    expect(planned.every((p) => p.requires_manual == null)).toBe(true);

    const dividend = planned.find((p) => p.source.kind === "dividend")!;
    const buy = planned.find((p) => p.source.kind === "buy")!;
    // Dividend flows equity → cash; the reinvestment flows back carrying the units.
    expect(dividend.from_account_id).toBe(buy.to_account_id);
    expect(dividend.to_account_id).toBe(buy.from_account_id);
    expect(dividend.flow_kind).toBe("dividend_payout");
    expect(dividend.units_delta).toBeNull();
    expect(buy.flow_kind).toBe("stock_buy");
    expect(buy.units_delta).toBe("0.002152366");
    expect(buy.occurred_on).toBe("2026-08-05");
  });

  it("resolves the fund name even though the subject is HTML-escaped", () => {
    // The real subject contains "S&amp;P 500", so a pattern written with a plain "&" never
    // matched — the SPY import only worked because the dividend pairing carried it.
    expect(
      tickerFromFundName(
        "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&amp;P 500 ETF Trust"
      )
    ).toBe("SPY");
  });

  it("prefers the fund name over the amount pairing when reinvestment is off", () => {
    // Dividend reinvestment disabled, and the cash later spent on a DIFFERENT instrument that
    // happens to cost the same on the same day. Pairing would say SPY; the subject says LIN.
    const seeded = seedFintualAccounts();
    if (!seeded) return;
    const dividend = classifyBrokerEmail(DIVIDEND);
    const otherBuy = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Invertiste US $1,67 dólares en 0,002 acciones de Linde plc",
      date: "2026-08-05T14:00:00Z",
    });
    // Both resolve and they disagree → refuse rather than pick one.
    const planned = planFintualEmailBatch([dividend, otherBuy]);
    const buy = planned.find((p) => p.source.kind === "buy")!;
    expect(buy.requires_manual).toMatch(/names LIN but pairs by amount with a SPY dividend/);
    // The dividend itself is unaffected — it is always equity → cash.
    expect(planned.find((p) => p.source.kind === "dividend")!.requires_manual).toBeNull();
  });

  it("still books the dividend correctly when nothing is reinvested", () => {
    const seeded = seedFintualAccounts();
    if (!seeded) return;
    // No "Invertiste" mail at all — the dividend stands alone as cash into the wallet.
    const planned = planFintualEmailBatch([classifyBrokerEmail(DIVIDEND)]);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      flow_kind: "dividend_payout",
      from_account_id: seeded.spy,
      to_account_id: seeded.cash,
      requires_manual: null,
    });
  });

  /**
   * A withdrawal is only written once its bank leg exists, and then by promoting that row rather
   * than inserting a second one. With no matching checking credit — the case here — nothing is
   * written, which is what keeps the money from being counted twice.
   */
  it("does not write cash leaving Fintual until its checking credit exists", () => {
    const planned = planFintualEmailBatch([
      classifyBrokerEmail({
        sender: FINTUAL,
        subject: "Pagamos tu retiro de 🏦 Reserva",
        snippet: "Pagamos tu retiro de $2.000.000 desde 🏦 Reserva",
        date: "2026-07-08T15:13:19Z",
      }),
    ]);
    expect(planned[0]!.requires_manual).not.toBeNull();
    expect(planned[0]!.from_account_id).toBeNull();
    expect(planned[0]!.promote_movement_id).toBeUndefined();
  });

  /**
   * The retiro's cuota count rides the promotion: the goal's value is cuotas × px, so a
   * promoted transfer without `units_delta` would leave the goal's value unchanged forever.
   * Snippet text is the real 2026-08-07 mail.
   */
  it("promotes the checking credit with the cuota count from the e-mail body", () => {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return; // synthetic DB without a cuenta corriente — nothing to pair against
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Reserva', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva')`
    ).run(group.id);
    createdAccounts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    const goalId = createdAccounts[createdAccounts.length - 1]!;

    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, 1300000, 'clp', '2026-08-10', 'vitest-retiro-credit')`
    ).run(checkingId);
    const creditId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(creditId);

    const email = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 vitest Reserva",
      snippet:
        "Se pagó a tu cuenta de banco. Hola Cristian Pagamos tu retiro de $1.300.000 El viernes 07 " +
        "de agosto a las 15:56 pagamos tu retiro desde 🏦 vitest Reserva. Monto $1.300.000 Destino " +
        "Cuenta 11111111 de Banco Santander El retiro se hizo desde el Fondo Mutuo Very " +
        "Conservative Streep Serie A (900,3208 cuotas).",
      date: "2026-08-07T19:56:08Z",
    });
    expect(email.units).toBe("900.3208");

    const planned = planFintualEmailBatch([email]);
    expect(planned[0]).toMatchObject({
      promote_movement_id: creditId,
      from_account_id: goalId,
      units_delta: "900.3208",
      // The e-mail's payment date (Friday), not the bank's next-workday posting date (Monday
      // the 10th): the wire beat the 14:00 cutoff, and Friday is still inside the cartola
      // re-import dedupe window for a Monday bank row.
      occurred_on: "2026-08-07",
      requires_manual: null,
    });

    applyFintualEmailMovements(planned);
    const row = db
      .prepare(
        `SELECT from_account_id, to_account_id, units_delta, occurred_on FROM movements WHERE id = ?`
      )
      .get(creditId) as {
      from_account_id: number;
      to_account_id: number;
      units_delta: number;
      occurred_on: string;
    };
    expect(row.from_account_id).toBe(goalId);
    expect(row.to_account_id).toBe(checkingId);
    expect(row.units_delta).toBeCloseTo(900.3208, 4);
    expect(row.occurred_on).toBe("2026-08-07");
  });

  it("keeps the bank posting date when the payment date would straddle a month boundary", () => {
    // Paid the 31st, posted the 1st: dating the transfer in the earlier month would put the
    // credit in a cartola period whose saldo_final excludes it, corrupting the checking anchor.
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return;
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Reserva3', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva3')`
    ).run(group.id);
    createdAccounts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, 500000, 'clp', '2026-09-01', 'vitest-retiro-credit-3')`
    ).run(checkingId);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    const planned = planFintualEmailBatch([
      classifyBrokerEmail({
        sender: FINTUAL,
        subject: "Pagamos tu retiro de 🏦 vitest Reserva3",
        snippet:
          "Pagamos tu retiro de $500.000 desde 🏦 vitest Reserva3. El retiro se hizo desde el " +
          "Fondo Mutuo Very Conservative Streep Serie A (350,25 cuotas).",
        date: "2026-08-31T19:00:00Z",
      }),
    ]);
    expect(planned[0]!.requires_manual).toBeNull();
    expect(planned[0]!.occurred_on).toBe("2026-09-01");
  });

  it("refuses to promote a retiro whose body names no single cuota count", () => {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return;
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Reserva2', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva2')`
    ).run(group.id);
    createdAccounts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, 2000000, 'clp', '2026-08-10', 'vitest-retiro-credit-2')`
    ).run(checkingId);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    // A multi-fund goal prints one count per fund — a single number would be wrong for all.
    const planned = planFintualEmailBatch([
      classifyBrokerEmail({
        sender: FINTUAL,
        subject: "Pagamos tu retiro de 🏦 vitest Reserva2",
        snippet:
          "Pagamos tu retiro de $2.000.000 desde 🏦 vitest Reserva2. El retiro se hizo desde el " +
          "Fondo A (100,5 cuotas) y el Fondo B (200,25 cuotas).",
        date: "2026-08-07T19:56:08Z",
      }),
    ]);
    expect(planned[0]!.requires_manual).toMatch(/cuota/);
    expect(planned[0]!.promote_movement_id).toBeUndefined();
  });

  it("matches a certificado-dated row five days earlier as the same event", () => {
    // E-mails carry the PAYMENT date; the certificado dates the dividend at its accrual date,
    // up to five days before. Without the window the same event imports twice.
    const accounts = db.prepare(`SELECT id FROM accounts ORDER BY id LIMIT 2`).all() as {
      id: number;
    }[];
    if (accounts.length < 2) return;
    const [from, to] = [accounts[0]!.id, accounts[1]!.id];
    db.prepare(
      `INSERT INTO movements (from_account_id, to_account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 1.67, 'usd', '2026-07-31', 'vitest-cert-dated')`
    ).run(from, to);
    created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    const planned: FintualPlannedMovement = {
      source: classifyBrokerEmail(DIVIDEND),
      occurred_on: "2026-08-05", // payment date, 5 days after the accrual date above
      from_account_id: from,
      to_account_id: to,
      account_id: null,
      amount: 1.67,
      currency: "usd",
      units_delta: null,
      flow_kind: "dividend_payout",
      note: "vitest",
      duplicate_of: null,
      requires_manual: null,
    };
    expect(markFintualDuplicates([planned])[0]!.duplicate_of).toBe(created[created.length - 1]);

    // Outside the window it is a different event.
    expect(
      markFintualDuplicates([{ ...planned, occurred_on: "2026-08-12" }])[0]!.duplicate_of
    ).toBeNull();
  });
});
