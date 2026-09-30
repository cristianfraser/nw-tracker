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
import { bankPostedOn } from "./movementBankPostings.js";

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
   * Synthesis and promotion both need the retiro fully resolved first: an unrecognised goal (or
   * a body without a single cuota count, as here) refuses rather than guessing which account
   * paid or how many cuotas it sold.
   */
  it("refuses a retiro it cannot fully resolve instead of synthesizing", () => {
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
    expect(planned[0]!.synthesized).toBeUndefined();
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

  it("dates a month-straddling retiro on the payment day and keeps the bank date as its posting", () => {
    // Paid the 31st, posted the 1st: the display reads August, the cartola checks read the
    // September posting (`movement_bank_postings`).
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
    expect(planned[0]!.occurred_on).toBe("2026-08-31");
    const creditId = planned[0]!.promote_movement_id!;
    expect(creditId).toBe(created[created.length - 1]);
    applyFintualEmailMovements(planned);
    expect(
      (db.prepare(`SELECT occurred_on FROM movements WHERE id = ?`).get(creditId) as { occurred_on: string })
        .occurred_on
    ).toBe("2026-08-31");
    expect(bankPostedOn(creditId, checkingId)).toBe("2026-09-01");
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

  it("books a retiro to the Fintual balance as goal → Fintual CLP, never touching checking", () => {
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    const mk = (name: string, importKey: string): number => {
      const existing = db.prepare(`SELECT id FROM accounts WHERE import_key = ?`).get(importKey) as
        | { id: number }
        | undefined;
      if (existing) return existing.id;
      db.prepare(
        `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
         VALUES (?, ?, 0, datetime('now'), ?)`
      ).run(group.id, name, importKey);
      const id = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
      createdAccounts.push(id);
      return id;
    };
    const goalId = mk("vitest Reserva Disp", "import:fintual|cert|key=vitest-reserva-disp");
    const balanceId = mk("vitest Fintual CLP", "import:panel|kind=clp|key=fintual");

    const email = classifyBrokerEmail({
      message_id: `vitest-disp-${Date.now()}`,
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 vitest Reserva Disp",
      snippet:
        "Pagamos tu retiro de $100.000 El martes 29 de septiembre a las 11:00 tus $100.000 pesos " +
        "chilenos quedaron disponibles para invertir en Fintual. Se retiró de 🏦 vitest Reserva " +
        "Disp : $100.000 desde Fondo Mutuo Very Conservative Streep Serie A, equivalente a 68,8876 cuotas .",
      date: "2097-09-29T14:00:33Z",
    });
    const planned = planFintualEmailBatch([email]);
    expect(planned[0]).toMatchObject({
      from_account_id: goalId,
      to_account_id: balanceId,
      units_delta: "68.8876",
      occurred_on: "2097-09-29",
      requires_manual: null,
      duplicate_of: null,
    });
    expect(planned[0]!.synthesized).toBeUndefined();
    expect(planned[0]!.promote_movement_id).toBeUndefined();

    expect(applyFintualEmailMovements(planned)).toBe(1);
    const mov = db
      .prepare(`SELECT id, to_account_id, amount, units_delta FROM movements WHERE from_account_id = ?`)
      .get(goalId) as { id: number; to_account_id: number; amount: number; units_delta: number };
    created.push(mov.id);
    expect(mov).toMatchObject({ to_account_id: balanceId, amount: 100000 });
    expect(mov.units_delta).toBeCloseTo(68.8876, 4);
    // A later run finds it.
    expect(planFintualEmailBatch([email])[0]!.duplicate_of).toBe(mov.id);
  });

  /**
   * A retiro paid in the morning has no checking credit to promote until the nightly xlsx
   * import — the mail alone (exact amount, payment date, goal, cuota count) is enough to write
   * the transfer, so the goal's cuotas drop the day they were sold instead of the NAV drop
   * stranding in the day's P/L. The checking importers later skip the bank's listing as
   * superseded_by_transfer and stamp the confirmation row this synthesis records.
   */
  it("synthesizes the transfer from the mail when the checking credit is not imported yet", () => {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return; // synthetic DB without a cuenta corriente
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Reserva Synth', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva-synth')`
    ).run(group.id);
    const goalId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdAccounts.push(goalId);

    const email = classifyBrokerEmail({
      message_id: `vitest-synth-${Date.now()}`,
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 vitest Reserva Synth",
      snippet:
        "Se pagó a tu cuenta de banco. Hola Cristian Pagamos tu retiro de $654.321 El viernes 07 " +
        "de agosto a las 11:17 pagamos tu retiro desde 🏦 vitest Reserva Synth. Monto $654.321 " +
        "Destino Cuenta 11111111 de Banco Santander El retiro se hizo desde el Fondo Mutuo Very " +
        "Conservative Streep Serie A (452,7789 cuotas).",
      date: "2026-08-07T15:17:53Z",
    });
    const planned = planFintualEmailBatch([email]);
    expect(planned[0]).toMatchObject({
      from_account_id: goalId,
      to_account_id: checkingId,
      units_delta: "452.7789",
      occurred_on: "2026-08-07",
      synthesized: true,
      requires_manual: null,
      duplicate_of: null,
    });
    expect(planned[0]!.promote_movement_id).toBeUndefined();

    expect(applyFintualEmailMovements(planned)).toBe(1);
    const mov = db
      .prepare(
        `SELECT id, to_account_id, amount, units_delta, occurred_on FROM movements WHERE from_account_id = ?`
      )
      .get(goalId) as {
      id: number;
      to_account_id: number;
      amount: number;
      units_delta: number;
      occurred_on: string;
    };
    created.push(mov.id);
    expect(mov.to_account_id).toBe(checkingId);
    expect(mov.amount).toBe(654321);
    expect(mov.units_delta).toBeCloseTo(452.7789, 4);
    expect(mov.occurred_on).toBe("2026-08-07");

    const expectation = db
      .prepare(
        `SELECT message_id, amount_clp, paid_on, confirmed_on FROM fintual_synthetic_retiro_transfers
         WHERE movement_id = ?`
      )
      .get(mov.id) as { message_id: string; amount_clp: number; paid_on: string; confirmed_on: string | null };
    expect(expectation).toMatchObject({
      message_id: email.message_id,
      amount_clp: 654321,
      paid_on: "2026-08-07",
      confirmed_on: null,
    });

    // A later run sees its own synthesis as the ledger row for this mail — nothing doubles.
    const again = planFintualEmailBatch([email]);
    expect(again[0]!.duplicate_of).toBe(mov.id);
    expect(applyFintualEmailMovements(again)).toBe(0);
  });

  it("refuses to synthesize when several unpaired credits match", () => {
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
       VALUES (?, 'vitest Reserva Amb', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva-amb')`
    ).run(group.id);
    createdAccounts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    // Both AFTER the payment day — only forward-dated credits are candidates at all.
    for (const ymd of ["2026-08-08", "2026-08-10"]) {
      db.prepare(
        `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
         VALUES (?, 444555, 'clp', ?, 'vitest-ambiguous-credit')`
      ).run(checkingId, ymd);
      created.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);
    }

    const planned = planFintualEmailBatch([
      classifyBrokerEmail({
        sender: FINTUAL,
        subject: "Pagamos tu retiro de 🏦 vitest Reserva Amb",
        snippet:
          "Pagamos tu retiro de $444.555 desde 🏦 vitest Reserva Amb. El retiro se hizo desde el " +
          "Fondo Mutuo Very Conservative Streep Serie A (300,1 cuotas).",
        date: "2026-08-07T15:00:00Z",
      }),
    ]);
    expect(planned[0]!.requires_manual).toMatch(/several unpaired/);
    expect(planned[0]!.synthesized).toBeUndefined();
    expect(planned[0]!.from_account_id).toBeNull();
  });

  it("synthesizes on the month's last business day too", () => {
    try {
      checkingAccountId();
    } catch {
      return;
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, 'vitest Reserva EOM', 0, datetime('now'), 'import:fintual|cert|key=vitest-reserva-eom')`
    ).run(group.id);
    createdAccounts.push((db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id);

    // Paid Monday the 31st: the bank may post the credit on September 1st — the transfer is
    // still dated the 31st, and the bank row brings its posting day when it lands.
    const planned = planFintualEmailBatch([
      classifyBrokerEmail({
        sender: FINTUAL,
        subject: "Pagamos tu retiro de 🏦 vitest Reserva EOM",
        snippet:
          "Pagamos tu retiro de $123.456 desde 🏦 vitest Reserva EOM. El retiro se hizo desde el " +
          "Fondo Mutuo Very Conservative Streep Serie A (80,5 cuotas).",
        date: "2026-08-31T14:00:00Z",
      }),
    ]);
    expect(planned[0]!.requires_manual).toBeNull();
    expect(planned[0]!.synthesized).toBe(true);
    expect(planned[0]!.occurred_on).toBe("2026-08-31");
  });

  /** Goal account + one unpaired checking credit; returns null on a DB without a cuenta corriente. */
  function seedGoalAndCredit(
    slug: string,
    amount: number,
    creditYmd: string
  ): { checkingId: number; goalId: number; creditId: number } | null {
    let checkingId: number;
    try {
      checkingId = checkingAccountId();
    } catch {
      return null;
    }
    const group = db.prepare(`SELECT id FROM asset_groups ORDER BY id LIMIT 1`).get() as
      | { id: number }
      | undefined;
    if (!group) return null;
    db.prepare(
      `INSERT INTO accounts (asset_group_id, name, exclude_from_group_totals, created_at, import_key)
       VALUES (?, ?, 0, datetime('now'), ?)`
    ).run(group.id, `vitest Reserva ${slug}`, `import:fintual|cert|key=vitest-reserva-${slug}`);
    const goalId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    createdAccounts.push(goalId);
    db.prepare(
      `INSERT INTO movements (account_id, amount, currency, occurred_on, note)
       VALUES (?, ?, 'clp', ?, ?)`
    ).run(checkingId, amount, creditYmd, `vitest-retiro-credit-${slug}`);
    const creditId = (db.prepare(`SELECT last_insert_rowid() AS id`).get() as { id: number }).id;
    created.push(creditId);
    return { checkingId, goalId, creditId };
  }

  function retiroMail(slug: string, amountLabel: string, cuotas: string, date: string, messageId?: string) {
    return classifyBrokerEmail({
      message_id: messageId ?? null,
      sender: FINTUAL,
      subject: `Pagamos tu retiro de 🏦 vitest Reserva ${slug}`,
      snippet:
        `Pagamos tu retiro de $${amountLabel} desde 🏦 vitest Reserva ${slug}. El retiro se hizo ` +
        `desde el Fondo Mutuo Very Conservative Streep Serie A (${cuotas} cuotas).`,
      date,
    });
  }

  it("plans one row when the same mail sits in two scan files", () => {
    // The 2026-08-31 incident: IMAP SINCE is day-granular, so the watermark message came back
    // in the next scan too. Both copies planned `promote <same credit>`; the second promote
    // threw and rolled back the batch on every run for four days.
    const seeded = seedGoalAndCredit("dup", 100000, "2026-08-31");
    if (!seeded) return;
    const id = `<vitest-dup-${Date.now()}@example>`;
    const copy1 = retiroMail("dup", "100.000", "69,1041", "2026-08-31T15:08:35Z", id);
    const copy2 = retiroMail("dup", "100.000", "69,1041", "2026-08-31T15:08:35Z", id);

    const planned = planFintualEmailBatch([copy1, copy2]);
    expect(planned).toHaveLength(1);
    expect(planned[0]).toMatchObject({
      promote_movement_id: seeded.creditId,
      requires_manual: null,
      duplicate_of: null,
    });
    expect(applyFintualEmailMovements(planned)).toBe(1);
    const row = db
      .prepare(`SELECT from_account_id, to_account_id FROM movements WHERE id = ?`)
      .get(seeded.creditId) as { from_account_id: number; to_account_id: number };
    expect(row.from_account_id).toBe(seeded.goalId);
    expect(row.to_account_id).toBe(seeded.checkingId);
  });

  it("keeps two distinct same-day retiros of the same amount apart", () => {
    // Different Message-IDs are different events even when amount, cuotas and day coincide.
    const seeded = seedGoalAndCredit("twin", 100000, "2026-08-31");
    if (!seeded) return;
    const a = retiroMail("twin", "100.000", "69,1041", "2026-08-31T15:08:35Z", `<vitest-twin-a-${Date.now()}>`);
    const b = retiroMail("twin", "100.000", "69,1041", "2026-08-31T15:47:56Z", `<vitest-twin-b-${Date.now()}>`);

    const planned = planFintualEmailBatch([a, b]);
    expect(planned).toHaveLength(2);
    // Only one unpaired credit exists: the first mail claims it, the second is refused instead
    // of re-promoting the same row (which would throw and roll back both).
    expect(planned[0]!.promote_movement_id).toBe(seeded.creditId);
    expect(planned[0]!.requires_manual).toBeNull();
    expect(planned[1]!.requires_manual).toMatch(/already claimed/);
    expect(applyFintualEmailMovements(planned)).toBe(1);
  });

  it("never pairs a credit dated before the payment day", () => {
    // 2026-09-01: the $5x.xxx retiro's real bank leg was not imported yet, and the symmetric
    // window handed it an unrelated $5x.xxx credit from 2026-08-28 — which got rewritten in
    // place into a Fintual transfer. A wire cannot post before the fund paid it.
    const seeded = seedGoalAndCredit("early", 50000, "2026-08-28");
    if (!seeded) return;
    const planned = planFintualEmailBatch([
      retiroMail("early", "50.000", "34,5414", "2026-09-01T15:49:25Z", `<vitest-early-${Date.now()}>`),
    ]);
    expect(planned[0]!.promote_movement_id).toBeUndefined();
    // With no forward-dated candidate the mail synthesizes its own transfer (a Tuesday: next
    // business day stays inside the month), and the 08-28 credit is left exactly as it was.
    expect(planned[0]!.synthesized).toBe(true);
    expect(applyFintualEmailMovements(planned)).toBe(1);
    const synthesized = db
      .prepare(`SELECT id FROM movements WHERE from_account_id = ? AND to_account_id = ?`)
      .get(seeded.goalId, seeded.checkingId) as { id: number };
    created.push(synthesized.id);
    const untouched = db
      .prepare(`SELECT account_id, from_account_id, note FROM movements WHERE id = ?`)
      .get(seeded.creditId) as { account_id: number; from_account_id: number | null; note: string };
    expect(untouched).toEqual({
      account_id: seeded.checkingId,
      from_account_id: null,
      note: "vitest-retiro-credit-early",
    });
  });

  it("recognises its own synthesis by Message-ID even when the ledger row moved", () => {
    // The synthetic table is UNIQUE on message_id; if the transfer were later re-dated outside
    // the ±5-day ledger match the importer must still see the mail as done, not re-insert.
    const seeded = seedGoalAndCredit("moved", 77777, "2026-09-20"); // credit far away: unused
    if (!seeded) return;
    const id = `<vitest-moved-${Date.now()}>`;
    const mail = retiroMail("moved", "77.777", "55,5", "2026-08-04T15:00:00Z", id);
    const first = planFintualEmailBatch([mail]);
    expect(first[0]!.synthesized).toBe(true);
    expect(applyFintualEmailMovements(first)).toBe(1);
    const mov = db
      .prepare(`SELECT id FROM movements WHERE from_account_id = ? AND occurred_on = '2026-08-04'`)
      .get(seeded.goalId) as { id: number };
    created.push(mov.id);
    db.prepare(`UPDATE movements SET occurred_on = '2026-07-01' WHERE id = ?`).run(mov.id);

    const again = planFintualEmailBatch([mail]);
    expect(again[0]!.duplicate_of).toBe(mov.id);
    expect(applyFintualEmailMovements(again)).toBe(0);
  });
});
