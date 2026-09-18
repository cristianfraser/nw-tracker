import { describe, expect, it } from "vitest";
import {
  brokerFromSender,
  classifyBrokerEmail,
  collapseBrokerEmailEventsByMessageId,
  parseChileanNumber,
  parseUsNumber,
  scanBrokerEmails,
} from "./brokerEmailParse.js";

/**
 * Every subject here is a real message from the account (2026-03 … 2026-08), including the
 * 2026-08-05 SPY dividend and its reinvestment — the pair that prompted this whole connector.
 */
const FINTUAL = "hola@fintual.com";
const RACIONAL = "racional@racional.cl";

describe("brokerEmailParse", () => {
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
      amount: 2.75,
      currency: "usd",
      is_transaction: true,
      is_complete: true,
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

  it("never asks to fetch a broker that has no fetcher", () => {
    // Fintual is e-mail-only. An incomplete notification there is for a human to look at —
    // reporting it as "needs fetch" would ask the runner to do something that does not exist.
    const scan = scanBrokerEmails([
      { sender: FINTUAL, subject: "Pagamos tu retiro de 🏦 Reserva", date: "x" },
    ]);
    expect(scan.nudges).toHaveLength(1);
    expect(scan.needsFetch).toEqual([]);
    expect(scan.unresolved).toHaveLength(1);
  });

  it("only fetches a broker that has activity its e-mail does not describe", () => {
    // Complete e-mails are enough on their own — no browser.
    const completeOnly = scanBrokerEmails([
      { sender: RACIONAL, subject: "Así se movió tu plata en junio", date: "x" },
      { sender: "newsletter@fintualist.com", subject: "Se disipa la niebla", date: "x" },
      { sender: FINTUAL, subject: "Recibiste un dividendo de SPY por 1,67 dólares", date: "x" },
      {
        sender: RACIONAL,
        subject: "Invertiste en Silver Trust ETF iShares (SLV)",
        snippet:
          "Acciones compradas 24.74186066 Precio promedio US$54.41 Monto comprado US$1346.17",
        date: "x",
      },
    ]);
    expect(completeOnly.importable).toHaveLength(2);
    expect(completeOnly.nudges).toHaveLength(0);
    expect(completeOnly.needsFetch).toEqual([]);

    // A dividend nudge is what earns a fetch.
    const withNudge = scanBrokerEmails([
      { sender: RACIONAL, subject: "Recibiste dividendos de VEA 💸", date: "x" },
      { sender: FINTUAL, subject: "Recibiste un dividendo de SPY por 1,67 dólares", date: "x" },
    ]);
    expect(withNudge.needsFetch).toEqual(["racional"]);
    expect(withNudge.importable.map((e) => e.ticker)).toEqual(["SPY"]);
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
