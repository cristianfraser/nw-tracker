import { describe, expect, it } from "vitest";
import { mimeBodyToText } from "../email/mime.js";
import { decodeMetlifePaymentReceipt } from "./paymentReceiptMail.js";

// Synthetic values throughout.
const SUBJECT = "Pago de dividendo realizado";
const HTML =
  "<html><head><style>td{color:red}</style></head><body><p>El pago de tu dividendo se realiz&oacute; exitosamente</p>" +
  "<table><tr><td>Monto total pagado</td><td><b>$123.456</b></td></tr>" +
  "<tr><td>ID transacci&oacute;n</td><td>55501234</td></tr>" +
  "<tr><td>Fecha de pago</td><td>03/02/2030</td></tr></table>" +
  "<table><tr><th>Cr&eacute;dito</th><th>N&deg; de dividendo</th><th>Fecha de vencimiento</th></tr>" +
  "<tr><td>2029010101B007</td><td>2029010101B007203003</td><td>10/03/2030</td></tr></table>" +
  "<p>Ll&aacute;manos al 600 000 0000</p></body></html>";
const GMAIL_PLAIN =
  "El pago de tu dividendo se realizó exitosamente\n\n| Monto total pagado | $123.456 |\n|---|---|\n| ID transacción | 55501234 |\n" +
  "| Fecha de pago | 03/02/2030 |\n\n| Crédito | N° de dividendo | Fecha de vencimiento |\n|---|---|---|\n" +
  "| 2029010101B007 | 2029010101B007203003 | 10/03/2030 |\n";

const EXPECTED = {
  lender: "metlife",
  transaction_id: "55501234",
  paid_on: "2030-02-03",
  amount_clp: 123456,
  credit_number: "2029010101B007",
  dividend_number: "2029010101B007203003",
  due_on: "2030-03-10",
};

describe("decodeMetlifePaymentReceipt", () => {
  it("reads the archive's rendering of the HTML mail", () => {
    expect(decodeMetlifePaymentReceipt({ subject: SUBJECT, text: mimeBodyToText(HTML, 8000) })).toEqual(EXPECTED);
  });
  it("reads Gmail's plain rendering with its table borders", () => {
    expect(decodeMetlifePaymentReceipt({ subject: SUBJECT, text: GMAIL_PLAIN })).toEqual(EXPECTED);
  });
  it("tolerates accents lost to unknown entities", () => {
    const lossy = mimeBodyToText(HTML.replace("&oacute;n", "&#243;n").replace("&eacute;", "&#233;"), 8000);
    expect(decodeMetlifePaymentReceipt({ subject: SUBJECT, text: lossy })).toEqual(EXPECTED);
  });
  it("is null for another mail from the sender", () => {
    expect(decodeMetlifePaymentReceipt({ subject: "Tu cartola anual", text: "Monto total pagado $1" })).toBeNull();
  });
  it("throws on a receipt subject that does not decode", () => {
    expect(() => decodeMetlifePaymentReceipt({ subject: SUBJECT, text: "El pago de tu dividendo se realizó exitosamente" })).toThrow(/does not decode/);
  });
});
