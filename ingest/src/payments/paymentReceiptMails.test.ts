import { describe, expect, it } from "vitest";
import { PAYMENT_PROCESSORS } from "./paymentReceiptMails.js";

const flow = PAYMENT_PROCESSORS.find((p) => p.slug === "flow")!;
const pagoFacil = PAYMENT_PROCESSORS.find((p) => p.slug === "pago_facil")!;
const shopify = PAYMENT_PROCESSORS.find((p) => p.slug === "shopify")!;
const mail = (from: string, subject: string, sent: string, text: string) => ({ message_id: `<${sent}@test>`, sent_at_chile: sent, from, subject, text });

describe("payment receipt mails", () => {
  it("reads Flow's receipt with labelled fields (2019–2024)", () => {
    const r = flow.decode(
      mail(
        "info@flow.cl",
        "Aviso de pago realizado - Flow",
        "2036-09-02 17:09",
        "Comprobante de pago Estimado persona@example.com , hemos confirmado el pago realizado a COURIER UNO Ltda por medio de nuestra plataforma de pagos. Información del pago: Nº Orden: 63797993 Fecha y hora: 02-09-2036 17:09 Monto: 125.716 CLP Medio de pago: Webpay Información de la orden del comercio: Concepto: Pago de impuestos del envio 1Z99 Nº Orden del comercio: 1648319 El cargo en su cartola dirá PAGOS.FLOW.CL (WEB) Importante: Flow sólo es responsable … comuníquese directamente con COURIER UNO Ltda al email pagos@example.com Este comprobante de pago no es una boleta"
      )
    )!;
    expect(r).toMatchObject({
      processor: "flow",
      payee: { name: "COURIER UNO Ltda", rut: null, email: "pagos@example.com" },
      amount: 125716,
      paid_at_chile: "2036-09-02 17:09",
      order_ref: "63797993",
      concept: "Pago de impuestos del envio 1Z99",
      statement_descriptor: "PAGOS.FLOW.CL (WEB)",
      payment_method: "Webpay",
    });
  });

  it("reads Flow's receipt without colons (2025 on)", () => {
    const r = flow.decode(
      mail(
        "info@flow.cl",
        "Aviso de pago realizado - Flow",
        "2036-05-27 14:32",
        "¡Hola persona@example.com! Hemos confirmado el pago realizado a Tienda.cl por medio de nuestra plataforma de pagos. A continuación te dejamos los detalles de tu comprobante de pago: Detalle Información Nº Orden 170317567 Fecha y hora 27-05-2036 14:32 Monto 205.000 CLP Medio de pago Webpay RUT 76496002-5 Razón social Venta articulos Concepto Vaporizadores El cargo en tu cartola dirá FLOW*TIENDA.CL Importante: … con Tienda.cl al email tienda@example.com Saluda atentamente"
      )
    )!;
    expect(r).toMatchObject({
      payee: { name: "Tienda.cl", rut: "76496002-5", email: "tienda@example.com" },
      amount: 205000,
      concept: "Vaporizadores",
      statement_descriptor: "FLOW*TIENDA.CL",
    });
  });

  it("reads Pago Fácil's receipt, dated by the mail", () => {
    const r = pagoFacil.decode(
      mail(
        "no-reply@sys.pagofacil.cl",
        "Tu comprobante de pedido #18399939887277",
        "2036-11-29 23:08",
        "Tu comprobante de pago. Comprobante de pedido El pago por el pedido #18399939887277 en Bicicletas Uno ha sido procesado de manera correcta. Se adjuntan los datos de la transacción : Método de pago WebpayPST Orden en Tienda 18399939887277 Cuotas 0 Orden en Mall 7480784 Tipo de Pago VN Monto Total $208970.00 Pago Fácil es solo el facilitador"
      )
    )!;
    expect(r).toMatchObject({ payee: { name: "Bicicletas Uno" }, amount: 208970, paid_at_chile: "2036-11-29 23:08", installments: null, order_ref: "18399939887277" });
  });

  it("skips a sender's non-receipts and throws on a receipt it cannot read", () => {
    expect(flow.decode(mail("info@flow.cl", "Aviso de transacción por pagar - Flow", "2036-01-01 10:00", "Nuestro cliente … le ha generado el siguiente cobro"))).toBeNull();
    expect(() => flow.decode(mail("info@flow.cl", "Aviso de pago realizado - Flow", "2036-01-01 10:00", "Comprobante de pago sin datos"))).toThrow(/payee/);
    expect(() =>
      pagoFacil.decode(mail("no-reply@sys.pagofacil.cl", "Tu comprobante de pedido #1", "2036-01-01 10:00", "El pago por el pedido #1 en X ha sido procesado Monto Total $10.50"))
    ).toThrow(/whole-peso/);
  });

  it("reads a Shopify shop's order confirmation: the shop from the bracket, the text or the sender", () => {
    const fromText = shopify.decode({
      ...mail(
        "contacto@tienda.example",
        "Confirmación de pedido K2430",
        "2036-07-02 17:51",
        "Tienda Uno Pedido K2430 ¡Gracias por tu compra! Hola, estamos preparando tu pedido. Resumen del pedido SHORT DOS × 1 M $24.990 Descuento ABC -$2.499 Subtotal $22.491 Envíos $2.990 Impuestos $4.068 Total $25.481 CLP Información del cliente … Métodos de pago Pago fácil_webpayplus — $25.481"
      ),
    })!;
    expect(fromText).toMatchObject({ processor: "shopify", payee: { name: "Tienda Uno" }, amount: 25481, order_ref: "K2430", concept: "SHORT DOS × 1 M" });
    const bracket = shopify.decode(
      mail(
        "store+1@t.shopifyemail.com",
        "[CARNES DOS 🥩] Confirmación de pedido #81701",
        "2036-06-12 20:29",
        "¡Gracias por tu compra! Pedido #81701 ¡Gracias por tu compra! Resumen del pedido Filete | 2,0 Kg x 1 Default Title $51.980 Descuento (450881) $-15.594 Subtotal $36.386 Envío $3.990 Total $40.376 CLP Información del cliente"
      )
    )!;
    expect(bracket).toMatchObject({ payee: { name: "CARNES DOS" }, amount: 40376, order_ref: "#81701", concept: "Filete | 2,0 Kg x 1" });
    const sender = shopify.decode({
      ...mail(
        "store+2@t.shopifyemail.com",
        "Confirmación de pedido #6822",
        "2036-05-14 16:14",
        "¡Gracias por tu compra! Pedido #6822 ¡Gracias por tu compra! Resumen del pedido (PREVENTA) Juego NSW × 1 $54.990 Subtotal $54.990 Retiro $0 Impuestos $8.780 Total $54.990 CLP Pago Checkout mercado pago Si tienes alguna pregunta"
      ),
      from_name: "Tienda Tres",
    })!;
    expect(sender).toMatchObject({ payee: { name: "Tienda Tres" }, concept: "(PREVENTA) Juego NSW × 1", payment_method: "Checkout mercado pago" });
    expect(shopify.decode(mail("persona@example.com", "Re: Confirmación de pedido #1", "2036-01-01 10:00", "Resumen del pedido x Subtotal $1 Total $1 CLP"))).toBeNull();
  });
});
