import { describe, expect, it } from "vitest";
import { cardPaymentReceiptKind } from "nw-tracker-contracts";
import { santanderPaymentReceiptPayload } from "./paymentReceipts.js";

/** Synthetic bodies mirroring the two real receipt templates (2026-08); synthetic amounts/card. */
const CLP_RECEIPT_TEXT =
  "Comprobante pago deuda Nacional de Tarjeta de Credito Tu pago de Tarjeta de Credito ha sido " +
  "realizado con exito. Estimado (a) VITEST PERSONA: Te enviamos el detalle del pago realizado " +
  "con fecha 07/08/2026 Monto del pago: 111.222 ORIGEN Tipo de cuenta: Nº de Cuenta: " +
  "0-000-00-00000-0 DESTINO Tarjeta: W. LIMITED VISA Nº de Tarjeta: **** **** **** 9999 " +
  "Tipo de pago: facturado";

const USD_RECEIPT_TEXT =
  "Santander Comprobante Pago de la deuda facturada en dólares Estimado (a) VITEST PERSONA: Te " +
  "enviamos el detalle de la operación de compra de dólares para abonar o pagar tu Tarjeta de " +
  "Crédito en dólares con fecha 07-08-2026 a las 15:54:18 hrs. Monto pagado (abono) USD 123,45 " +
  "Origen Tipo de cuenta Cuenta Corriente N° de cuenta 0-000-00-00000-0 Destino Tarjeta " +
  "W. LIMITED VISA N° de tarjeta *9999 Datos del pago Cantidad de Dólares USD 123,45 " +
  "Equivalente en pesos $ 115.733 Tipo de cambio $ 937,45 Folio de la operación 000000000001";

function staged(text: string) {
  return { message_id: "<vitest@test>", subject: "vitest", date: "2026-08-07T19:54:52Z", text };
}

describe("santanderPaymentReceiptPayload", () => {
  it("reads the peso receipt", () => {
    const payload = santanderPaymentReceiptPayload(staged(CLP_RECEIPT_TEXT));
    expect(payload).toEqual({
      issuer: "santander",
      paid_on: "2026-08-07",
      debt_currency: "clp",
      amount_clp: 111222,
      amount_usd: null,
      card_last4: "9999",
    });
    expect(cardPaymentReceiptKind.payload.safeParse(payload).success).toBe(true);
  });

  it("reads the dollar receipt: the peso equivalent is the checking debit", () => {
    expect(santanderPaymentReceiptPayload(staged(USD_RECEIPT_TEXT))).toEqual({
      issuer: "santander",
      paid_on: "2026-08-07",
      debt_currency: "usd",
      amount_clp: 115733,
      amount_usd: 123.45,
      card_last4: "9999",
    });
  });

  it("throws on a receipt with no date or no recognisable amount", () => {
    expect(() => santanderPaymentReceiptPayload(staged("Te enviamos el detalle del pago realizado con fecha 07/08/2026"))).toThrow(
      /amount/
    );
    expect(() => santanderPaymentReceiptPayload(staged("Monto del pago: 111.222"))).toThrow(/payment date/);
  });
});
