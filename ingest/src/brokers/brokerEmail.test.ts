import { describe, expect, it } from "vitest";
import {
  brokerFromSender,
  classifyBrokerEmail,
  collapseBrokerEmailEventsByMessageId,
  parseChileanNumber,
  parseUsNumber,
  scanBrokerEmails,
  toBrokerNotification,
  brokerNotificationsFromScan,
} from "./brokerEmail.js";

/**
 * Every subject here is a real message from the account (2026-03 … 2026-08), including the
 * 2026-08-05 SPY dividend and its reinvestment — the pair that prompted this whole connector.
 */
const FINTUAL = "hola@fintual.com";
const RACIONAL = "racional@racional.cl";

describe("brokerEmail", () => {
  it("only treats real broker senders as brokers", () => {
    expect(brokerFromSender(FINTUAL)).toBe("fintual");
    expect(brokerFromSender(RACIONAL)).toBe("racional");
    // Newsletters must never trigger a fetch.
    expect(brokerFromSender("newsletter@fintualist.com")).toBeNull();
    expect(brokerFromSender("racionalteam@racional.cl")).toBeNull();
  });

  it("keeps the two number formats apart", () => {
    // Subjects are Chilean: dot groups thousands, comma is the decimal.
    expect(parseChileanNumber("1.346,17")).toBe(1346.17);
    expect(parseChileanNumber("5.344,04")).toBe(5344.04);
    expect(parseChileanNumber("3.000.000")).toBe(3000000);
    expect(parseChileanNumber("1,67")).toBe(1.67);
    expect(() => parseChileanNumber("abc")).toThrow(/Unparseable/);

    // Racional's BODY is US-formatted in the very same e-mail — reading "54.41" the Chilean
    // way would give 5.441, a 100x error on the share price.
    expect(parseUsNumber("54.41")).toBe(54.41);
    expect(parseUsNumber("1346.17")).toBe(1346.17);
    expect(parseUsNumber("1,346.17")).toBe(1346.17);
    expect(parseChileanNumber("54.41")).toBe(5441);
  });

  it("parses the 2026-08-05 SPY dividend and its reinvestment", () => {
    const dividend = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Recibiste un dividendo de SPY por 1,67 dólares",
      date: "2026-08-05T06:07:41Z",
    });
    expect(dividend).toMatchObject({
      broker: "fintual",
      kind: "dividend",
      is_transaction: true,
      ticker: "SPY",
      amount: 1.67,
      currency: "usd",
    });

    const buy = classifyBrokerEmail({
      sender: FINTUAL,
      subject:
        "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&P 500 ETF Trust",
      date: "2026-08-05T13:33:15Z",
    });
    expect(buy).toMatchObject({ kind: "buy", is_transaction: true, amount: 1.67, currency: "usd" });
    // 9 decimals must survive as a string, never a float round-trip.
    expect(buy.units).toBe("0.002152366");
  });

  it("parses the 2026-09-17 LIN dividend whose subject dropped the amount (it moved to the body)", () => {
    const dividend = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Recibiste un dividendo de LIN",
      snippet:
        "Recibiste un dividendo de Linde plc. Hola Cristian Recibiste un dividendo de LIN por US $10,75 " +
        "y lo asignamos a tu cuenta Como el dividendo es mayor o igual a US $0,20, cuando abra el mercado " +
        "reinvertiremos este monto en acciones de Linde plc.",
      date: "2026-09-18T02:06:22Z",
    });
    expect(dividend).toMatchObject({
      kind: "dividend",
      is_transaction: true,
      is_complete: true,
      ticker: "LIN",
      amount: 10.75,
      currency: "usd",
    });
  });

  it("parses the 2026-09-18 «Reinvertimos» DRIP fill: ticker in the subject, the trade in the body", () => {
    const fill = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Reinvertimos tu dividendo de LIN",
      snippet:
        "Reinvertimos tu dividendo de LIN Hola Cristian Reinvertimos tu dividendo de $10,75 en LIN " +
        "Monto invertido US $10,75 Precio de la acción US $458,38 Acciones compradas 0,023452157 " +
        "Si tienes dudas responde este correo y te ayudamos.",
      date: "2026-09-18T13:30:07Z",
    });
    expect(fill).toMatchObject({
      kind: "buy",
      is_transaction: true,
      is_complete: true,
      ticker: "LIN",
      amount: 10.75,
      price: 458.38,
      currency: "usd",
    });
    expect(fill.units).toBe("0.023452157");
    // A body the parser cannot read leaves the fill incomplete — a nudge, never a unit-less row.
    const bare = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Reinvertimos tu dividendo de LIN",
      snippet: "Hola Cristian, revisa tu cuenta.",
      date: "2026-09-18T13:30:07Z",
    });
    expect(bare).toMatchObject({ kind: "buy", is_transaction: true, is_complete: false, ticker: "LIN" });
  });

  it("parses the 2026-10 «Recibimos tu depósito» mail: a wire waiting in the Fintual balance", () => {
    const deposit = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Recibimos tu depósito",
      snippet:
        "Decide cómo lo quieres invertir. Hola Cristian Recibimos tus $700.000 Decide cómo los " +
        "quieres invertir. Si no lo haces dentro de los próximos 7 días, devolveremos el depósito",
      date: "2026-10-07T14:24:12Z",
    });
    expect(deposit).toMatchObject({ kind: "deposit", is_complete: true, amount: 700000, currency: "clp" });
    const bare = classifyBrokerEmail({ sender: FINTUAL, subject: "Recibimos tu depósito", snippet: "Hola", date: "2026-10-07T14:24:12Z" });
    expect(bare).toMatchObject({ kind: "deposit", is_transaction: true, is_complete: false, amount: null });
  });

  it("parses «Compraste dólares»: dollars bought, pesos paid and the rate", () => {
    const fx = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Compraste dólares",
      snippet:
        "Hola Cristian Compraste US $ 711,05 El miércoles 7 de octubre a las 11:24 con tus $700.000 " +
        "pesos chilenos compraste US $ 711,05 a un tipo de cambio de $984,46 CLP/USD. Todo esto",
      date: "2026-10-07T14:24:53Z",
    });
    expect(fx).toMatchObject({
      kind: "wallet_funded",
      is_complete: true,
      amount: 711.05,
      clp_amount: 700000,
      price: 984.46,
      currency: "usd",
    });
  });

  it("keeps an amount-less dividend mail as an incomplete transaction, never a silent 'other'", () => {
    const dividend = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Recibiste un dividendo de LIN",
      snippet: "Hola Cristian, revisa tu cuenta.",
      date: "2026-09-18T02:06:22Z",
    });
    expect(dividend).toMatchObject({ kind: "dividend", is_transaction: true, is_complete: false, ticker: "LIN", amount: null });
  });

  it("does not count the pending order as a movement", () => {
    // "Invertiremos" is the instruction; "Invertiste" is the fill. Counting both would double.
    const order = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Invertiremos US $1,67 de tus dólares en State Street SPDR S&P 500 ETF Trust",
      date: "2026-08-05T06:07:43Z",
    });
    expect(order.kind).toBe("order_placed");
    expect(order.is_transaction).toBe(false);
  });

  it("parses a Racional purchase, including units and price from the body", () => {
    const buy = classifyBrokerEmail({
      sender: RACIONAL,
      subject: "Invertiste en Silver Trust ETF iShares (SLV)",
      snippet:
        "Tu orden de compra de Silver Trust ETF iShares (SLV) Acciones compradas 24.74186066 " +
        "Precio promedio US$54.41 Monto comprado US$1346.17 Comisión transacción US$0 Horario Mercado",
      date: "2026-07-01T16:47:32Z",
    });
    // Matches ledger movement 11110 exactly.
    expect(buy).toMatchObject({
      broker: "racional",
      kind: "buy",
      is_transaction: true,
      ticker: "SLV",
      amount: 1346.17,
      price: 54.41,
      currency: "usd",
    });
    expect(buy.units).toBe("24.74186066");
  });

  it("captures the wallet funding the app's movement list never shows", () => {
    const funded = classifyBrokerEmail({
      sender: RACIONAL,
      subject: "Agregaste USD $5.344,04 a tu Billetera",
      date: "2026-07-01T16:43:33Z",
    });
    // This is the CLP→USD conversion — ledger movement 11106's USD leg.
    expect(funded).toMatchObject({
      kind: "wallet_funded",
      is_transaction: true,
      amount: 5344.04,
      currency: "usd",
    });
  });

  it("recognises deposits, portfolio buys and dividends", () => {
    expect(
      classifyBrokerEmail({
        sender: RACIONAL,
        subject: "Tu depósito de CLP $3.000.000 está listo para invertir",
        date: "2026-07-02T23:01:50Z",
      })
    ).toMatchObject({ kind: "deposit", amount: 3000000, currency: "clp", is_transaction: true });

    expect(
      classifyBrokerEmail({
        sender: RACIONAL,
        subject: "Invertiste $3.000.000 en tu Portafolio IPSA 😎",
        date: "2026-07-04T01:32:34Z",
      })
    ).toMatchObject({ kind: "portfolio_buy", amount: 3000000, currency: "clp" });

    // Until 2026-09 the dividend mail named the instrument only: a nudge for the crawl.
    expect(
      classifyBrokerEmail({
        sender: RACIONAL,
        subject: "Recibiste dividendos de VEA 💸",
        date: "2026-06-23T10:46:13Z",
      })
    ).toMatchObject({ kind: "dividend", ticker: "VEA", is_transaction: true, is_complete: false, amount: null });
    // Since 2026-09-18 the subject carries the amount: complete, imports without a crawl.
    expect(
      classifyBrokerEmail({
        sender: RACIONAL,
        subject: "Recibiste USD $2,75 en dividendos de SOXX",
        date: "2026-09-18T11:57:16Z",
      })
    ).toMatchObject({
      kind: "dividend",
      ticker: "SOXX",
      // The subject figure is the GROSS dividend (Racional credited 2,34 after the 15% US
      // withholding), so it is recorded but never bookable: the event stays a nudge.
      amount: null,
      gross_amount: 2.75,
      currency: "usd",
      is_transaction: true,
      is_complete: false,
    });
  });

  it("never triggers on marketing, login alerts or statements", () => {
    const noise = [
      { sender: RACIONAL, subject: "🛡️ ¿Fuiste tú? Detectamos un inicio de sesión desde un nuevo dispositivo", date: "x" },
      { sender: RACIONAL, subject: "Cambia tu cuenta de Stocks a Margin y evita Alertas de Buena Fe", date: "x" },
      { sender: RACIONAL, subject: "Así se movió tu plata en junio", date: "x" },
      { sender: "newsletter@fintualist.com", subject: "¿Por qué están de moda los ETFs?", date: "x" },
      { sender: FINTUAL, subject: "Certificado de Transacciones", date: "x" },
      { sender: FINTUAL, subject: "Cartola mensual de Acciones", date: "x" },
    ];
    for (const n of noise) {
      expect(classifyBrokerEmail(n).is_transaction).toBe(false);
    }
  });

  it("treats Racional's dividend mail as a nudge, because it carries no amount", () => {
    // "Tienes nuevos dólares en tu Billetera … acabas de ganar dividendos por tu inversión en
    // VEA" — proof it happened, but nothing to import. This is what opens the browser.
    const nudge = classifyBrokerEmail({
      sender: RACIONAL,
      subject: "Recibiste dividendos de VEA 💸",
      snippet:
        "Tienes nuevos dólares en tu Billetera Cristian, acabas de ganar dividendos por tu " +
        "inversión en VEA (VEA). Ya puedes utilizarlo para comprar más Stocks.",
      date: "2026-06-23T10:46:13Z",
    });
    expect(nudge).toMatchObject({ kind: "dividend", is_transaction: true, is_complete: false });
    expect(nudge.amount).toBeNull();
  });

  it("reads a Fintual withdrawal amount out of the body, not the subject", () => {
    // The subject is just "Pagamos tu retiro de 🏦 Reserva"; the amount is in the body. Before
    // the IMAP body was decoded this parsed as an amount-less nudge and asked for a fetch.
    const paid = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 Reserva",
      snippet:
        "Se pagó a tu cuenta de banco. Hola Cristian Pagamos tu retiro de $2.000.000 " +
        "El miércoles 08 de julio a las 11:13 pagamos tu retiro desde 🏦 Reserva. Monto $2.000.000",
      date: "2026-07-08T15:13:19Z",
    });
    expect(paid).toMatchObject({
      kind: "withdrawal_paid",
      is_transaction: true,
      is_complete: true,
      amount: 2000000,
      currency: "clp",
    });
  });

  it("reads a retiro to the Fintual balance: destination and «equivalente a N cuotas»", () => {
    // The 2026-09-29 template: the pesos stay in Fintual for up to 7 days, and the cuota count
    // is no longer in parentheses.
    const paid = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 Reserva",
      snippet:
        "Cristian pagamos tu retiro de 🏦 Reserva Hola Cristian Pagamos tu retiro de $100.000 El " +
        "martes 29 de septiembre a las 11:00 tus $100.000 pesos chilenos quedaron disponibles para " +
        "invertir en Fintual. Se retiró de 🏦 Reserva : $100.000 desde Fondo Mutuo Very " +
        "Conservative Streep Serie A, equivalente a 68,8876 cuotas . Decide cómo lo quieres invertir.",
      date: "2026-09-29T14:00:33Z",
    });
    expect(paid).toMatchObject({
      kind: "withdrawal_paid",
      is_complete: true,
      amount: 100000,
      units: "68.8876",
      paid_to: "fintual",
    });
  });

  it("reads the goal a retiro was paid from, emoji and all", () => {
    const goal = (subject: string) => classifyBrokerEmail({ sender: FINTUAL, subject, date: "2026-08-07T19:56:08Z" }).goal_name;
    expect(goal("Pagamos tu retiro de 🏦 Reserva")).toBe("Reserva");
    expect(goal("Pagamos tu retiro de 💰 Mega Caca")).toBe("Mega Caca");
    expect(goal("Pagamos tu retiro")).toBeNull();
  });

  it("names the fund a buy bought, HTML entities decoded", () => {
    const buy = classifyBrokerEmail({
      sender: FINTUAL,
      subject: "Invertiste US $1,67 dólares en 0,002152366 acciones de State Street SPDR S&amp;P 500 ETF Trust",
      date: "2026-08-05T13:33:15Z",
    });
    expect(buy.fund_name).toBe("State Street SPDR S&P 500 ETF Trust");
  });

  it("sends each broker's money mails, collapsed and oldest first, as canonical notifications", () => {
    const scan = scanBrokerEmails([
      { message_id: "<b>", sender: RACIONAL, subject: "Recibiste dividendos de VEA 💸", date: "2026-09-22T10:40:49.000Z" },
      { message_id: "<a>", sender: RACIONAL, subject: "Tu depósito de CLP $1.000.000 está listo para invertir", date: "2026-09-01T12:00:00.000Z" },
      { message_id: "<n>", sender: RACIONAL, subject: "Así se movió tu plata en junio", date: "2026-07-01T12:00:00.000Z" },
      { message_id: "<f>", sender: FINTUAL, subject: "Recibiste un dividendo de SPY por 1,67 dólares", date: "2026-08-05T06:07:41Z" },
    ]);
    expect(scan.unrecognised.map((e) => e.message_id)).toEqual(["<n>"]);
    const racional = brokerNotificationsFromScan(scan, "racional");
    expect(racional.map((n) => [n.message_id, n.kind, n.amount])).toEqual([
      ["<a>", "deposit", 1_000_000],
      ["<b>", "dividend", null],
    ]);
    expect(brokerNotificationsFromScan(scan, "fintual")[0]).toMatchObject({
      kind: "dividend",
      ticker: "SPY",
      amount: 1.67,
      occurred_at: "2026-08-05T06:07:41.000Z",
    });
  });

  it("names a retiro to the Fintual balance the broker's balance, and refuses a mail with no id", () => {
    const paid = classifyBrokerEmail({
      message_id: "<p>",
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 Reserva",
      snippet:
        "Pagamos tu retiro de $100.000 El martes 29 de septiembre a las 11:00 tus $100.000 pesos chilenos " +
        "quedaron disponibles para invertir en Fintual. … Serie A, equivalente a 68,8876 cuotas .",
      date: "2026-09-29T14:00:33Z",
    });
    expect(toBrokerNotification(paid).paid_to).toBe("broker_balance");
    expect(() => toBrokerNotification({ ...paid, message_id: null })).toThrow(/no Message-ID/);
  });

  it("collapses a mail staged in several scan files to its richest parse", () => {
    const retiro = {
      sender: FINTUAL,
      subject: "Pagamos tu retiro de 🏦 Reserva",
      date: "2026-08-31T15:08:35Z",
    };
    const body =
      "Pagamos tu retiro de $100.000 desde 🏦 Reserva. El retiro se hizo desde el Fondo Mutuo " +
      "Very Conservative Streep Serie A (69,1041 cuotas).";
    const events = [
      // Short-preview copy from an older scan: amount only, no cuotas.
      classifyBrokerEmail({ ...retiro, message_id: "<m1>", snippet: "Pagamos tu retiro de $100.000" }),
      classifyBrokerEmail({ ...retiro, message_id: "<m1>", snippet: body }),
      // A different mail, same everything else — a real second retiro.
      classifyBrokerEmail({ ...retiro, message_id: "<m2>", snippet: body, date: "2026-08-31T15:47:56Z" }),
      // Hand-built input with no id passes through untouched.
      classifyBrokerEmail({ ...retiro, snippet: body }),
    ];
    const collapsed = collapseBrokerEmailEventsByMessageId(events);
    expect(collapsed).toHaveLength(3);
    const m1 = collapsed.find((e) => e.message_id === "<m1>")!;
    expect(m1.units).toBe("69.1041");
    expect(collapsed.filter((e) => e.message_id === "<m2>")).toHaveLength(1);
    expect(collapsed.filter((e) => e.message_id == null)).toHaveLength(1);
  });
});

// Real 2026-08-25 template excerpts (amounts anonymized to synthetic values).
const CONVERSION_SNIPPET =
  "*** Agregaste dólares a Billetera de Stocks *** Cristian, tus $1.086,49 dólares ya están en " +
  "tránsito a tu cuenta de inversión en Estados Unidos, y te aparecerán en tu Poder de Compra " +
  "( https://example.test ) para invertir en Stocks. Estos dólares los compraste con tu " +
  "depósito de $1.000.000, a un precio promedio de $920,39 por dólar.";

const BUY_SNIPPET_MARGIN_ERA =
  "*** Tu orden de compra de Vitest Semis ETF (VITSOX) *** Acciones compradas Acciones " +
  "vendidas 2.11462728 Precio promedio US$513.8 Monto comprado Monto vendido US$1086.49 " +
  "Comisión transacción US$0 Horario Extendido Mercado";

describe("brokerEmail — 2026-08 Racional templates", () => {
  it("parses the Margin-era buy body with interleaved column headers", () => {
    const buy = classifyBrokerEmail({
      sender: RACIONAL,
      subject: "Invertiste en Vitest Semis ETF (VITSOX)",
      snippet: BUY_SNIPPET_MARGIN_ERA,
      date: "2026-08-25T16:45:39.000Z",
    });
    expect(buy).toMatchObject({
      kind: "buy",
      is_transaction: true,
      is_complete: true,
      ticker: "VITSOX",
      amount: 1086.49,
      price: 513.8,
      currency: "usd",
    });
    expect(buy.units).toBe("2.11462728");
  });

  it("reads the conversion's CLP leg from the body (digit-terminated, sentence comma excluded)", () => {
    const funded = classifyBrokerEmail({
      sender: RACIONAL,
      subject: "Agregaste USD $1.086,49 a tu Billetera",
      snippet: CONVERSION_SNIPPET,
      date: "2026-08-25T16:44:14.000Z",
    });
    expect(funded).toMatchObject({
      kind: "wallet_funded",
      amount: 1086.49,
      currency: "usd",
      clp_amount: 1_000_000,
    });
  });
});
