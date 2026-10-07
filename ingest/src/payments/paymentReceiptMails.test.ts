import { describe, expect, it } from "vitest";
import { PAYMENT_PROCESSORS } from "./paymentReceiptMails.js";

const flow = PAYMENT_PROCESSORS.find((p) => p.slug === "flow")!;
const pagoFacil = PAYMENT_PROCESSORS.find((p) => p.slug === "pago_facil")!;
const shopify = PAYMENT_PROCESSORS.find((p) => p.slug === "shopify")!;
const shop = (slug: string) => PAYMENT_PROCESSORS.find((p) => p.slug === slug)!;
const eventbrite = shop("eventbrite");
const micoca = shop("micoca_cola");
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

describe("shop order confirmations: Calvin Klein, adidas, Club Dominó", () => {
  it("reads Calvin Klein's order: Total after the discount, items at the price paid", () => {
    const r = shop("calvin_klein").decode(
      mail(
        "calvinkleinchile@aswgr.com",
        "Tu pedido ha sido realizado exitosamente. | Calvin Klein",
        "2036-06-01 01:17",
        "PEDIDO CONFIRMADO ¡Hola Persona! Gracias por comprar en CalvinKlein.cl Tu pedido 1000000000001-01 fue confirmado. Resumen del Pedido Pantalón Uno TALLA:L Cant. 1 TALLA:L Ver producto $ 24.493 Pack Dos TALLA:M Cant. 2 TALLA:M Ver producto $ 47.988 Subtotal: $ 100.000 Descuento: $ -27.519 Total: $ 72.481 Detalles de la Compra Nombre Cliente Persona Ejemplo Método de Pago Webpay Valor: $ 72.481 GRACIAS"
      )
    )!;
    expect(r).toMatchObject({
      processor: "calvin_klein",
      payee: { name: "Calvin Klein" },
      amount: 72481,
      order_ref: "1000000000001-01",
      concept: "Pantalón Uno × 1 L · Pack Dos × 2 M",
      payment_method: "Webpay",
      paid_at_chile: "2036-06-01 01:17",
    });
  });

  it("reads adidas's order in both layouts and skips its shipping mails", () => {
    const adidas = shop("adidas");
    const old = adidas.decode(
      mail(
        "adidas@cl-info.adidas.com",
        "Persona, hemos recibido tu pedido",
        "2036-02-11 21:53",
        "HEMOS RECIBIDO TU PEDIDO Número de orden: ACL00000001 Buenas noticias RESUMEN DEL PEDIDO Detalles Del Envío Persona Calle Uno 1 Via: Standard Datos De Facturación Persona Calle Uno 1 Via: Master Card Resumen Del Pedido Productos $60.000 Código Promocional -$9.000 Entrega GRATIS Tax $8.143 Total $51.000 (impuestos incluidos) Ahorro total $9.000 TU PEDIDO Polera Uno $25.500 $30.000 Color: Black Talla: M Cantidad: 1 Artículo N°: AB1234 Gorro Dos $25.500 Color: White Talla: L Cantidad: 1 Artículo N°: CD5678 HABLA CON NOSOTROS ¿Qué probabilidad"
      )
    )!;
    expect(old).toMatchObject({ amount: 51000, order_ref: "ACL00000001", concept: "Polera Uno × 1 · Gorro Dos × 1", payment_method: "Master Card" });
    const twice = "Fecha de creación de la orden jueves, junio 4 Número de pedido ACL00000002 En proceso En tránsito Entregado Zapatilla Tres $69.990 Talla: L / Cantidad: 1 Color: Black Consultar pedido";
    const neu = adidas.decode(
      mail(
        "adidas@cl-info.adidas.com",
        "Gracias por tu pedido, Persona",
        "2036-06-03 20:28",
        `Gracias por tu pedido ${twice} ${twice} Forma de pago Forma de pago Tarjeta De Crédito/ Débito Total Total Artículos $ 69.990 Envío Free Total $ 69.990 (impuestos incluidos)`
      )
    )!;
    expect(neu).toMatchObject({ amount: 69990, order_ref: "ACL00000002", concept: "Zapatilla Tres × 1 L", payment_method: "Tarjeta De Crédito/ Débito" });
    expect(adidas.decode(mail("adidas@cl-info.adidas.com", "Tu pedido está en camino", "2036-06-04 19:08", "Número de pedido ACL00000002"))).toBeNull();
  });

  it("reads Club Dominó's comprobante with the order's own time and the tip in the total", () => {
    const r = shop("club_domino").decode(
      mail(
        "noresponder@clubdomino.domino.cl",
        "¡Pedido Confirmado! - Club Dominó",
        "2036-05-26 16:14",
        "¡Hola, Persona! Hemos recibido tu pedido. Comprobante # ABCD123-45678 Sucursal Uno mar., 6 may. 2036 en 16:13 Calle Uno 100, Santiago, Chile 1 Completo Italiano Papas (+$2.000) $5.000 Puntos obtenidos 70 Subtotal $7.000 Propina $700 Descuento -$1.000 Total $6.700 visa 0000"
      )
    )!;
    expect(r).toMatchObject({
      processor: "club_domino",
      payee: { name: "Club Dominó Sucursal Uno" },
      amount: 6700,
      paid_at_chile: "2036-05-06 16:13",
      order_ref: "ABCD123-45678",
      concept: "1 Completo Italiano Papas",
      payment_method: "visa 0000",
    });
  });

  it("throws on an order mail without its total or number, and on a peso amount with cents", () => {
    expect(() =>
      shop("calvin_klein").decode(mail("calvinkleinchile@aswgr.com", "Tu pedido ha sido realizado exitosamente. | Calvin Klein", "2036-01-01 10:00", "Tu pedido 1-01 fue confirmado. Resumen del Pedido X Subtotal: $ 1"))
    ).toThrow(/total/);
    expect(() => shop("adidas").decode(mail("adidas@cl-info.adidas.com", "Gracias por tu pedido, Persona", "2036-01-01 10:00", "Total $ 1.000 (impuestos incluidos)"))).toThrow(/order number/);
    expect(() =>
      shop("club_domino").decode(
        mail("x@clubdomino.domino.cl", "¡Pedido Confirmado!", "2036-01-01 10:00", "Comprobante # A-1 Sucursal lun., 5 may. 2036 en 10:00 Calle, Chile 1 Item $1.000 Subtotal $1.000 Total $1.000,50")
      )
    ).toThrow(/centavos/);
    expect(shop("club_domino").decode(mail("domino@news.domino.cl", "Vuelve hoy: 30% OFF", "2036-01-01 10:00", "promo"))).toBeNull();
  });
});

describe("Eventbrite order confirmations", () => {
  const paid = (total: string) =>
    mail(
      "noreply@order.eventbrite.com",
      "Order Confirmation for Feria Uno 2036",
      "2036-03-04 18:20",
      `Eventbrite Your Tickets for Feria Uno 2036 Ana, you've got tickets! Feria Uno 2036 2 x General Order total: ${total} Saturday, March 8, 2036 Questions about this event? Contact the organizer View event details Order Summary Order #99887766554 - March 4, 2036 Ana Pérez 2 x General CLP$12.000 Fees CLP$1.500 View and manage your order in your Eventbrite account.`
    );

  it("reads a paid order in pesos, the total with fees", () => {
    const r = eventbrite.decode(paid("CLP$25.500"))!;
    expect(r).toMatchObject({
      processor: "eventbrite",
      payee: { name: "Eventbrite" },
      amount: 25500,
      currency: "clp",
      paid_at_chile: "2036-03-04 18:20",
      order_ref: "99887766554",
      concept: "Feria Uno 2036 · 2 x General",
    });
  });

  it("names the organizer when the mail prints one", () => {
    const r = eventbrite.decode(
      mail(
        "orders@eventbrite.com",
        "Your Tickets for Charla Dos",
        "2036-04-12 15:33",
        "Hi Ana, this is your order confirmation for Charla Dos Organized by Club Ejemplo Here are your tickets Order Summary April 12, 2036 Order #: 123456789 Order total: CLP$ 8.000 This order is subject to Eventbrite Terms"
      )
    )!;
    expect(r).toMatchObject({ payee: { name: "Club Ejemplo" }, amount: 8000, order_ref: "123456789", concept: "Charla Dos" });
  });

  it("skips free orders (nothing was charged)", () => {
    expect(eventbrite.decode(paid("Free"))).toBeNull();
    expect(
      eventbrite.decode(
        mail("noreply@order.eventbrite.com", "Seus ingressos para festa", "2036-02-08 23:09", "festa 1 x ingresso Total do pedido: Gratuito Resumo de pedido Pedido #1 Pedido gratuito Ana 1 x General Admission R$ 0,00")
      )
    ).toBeNull();
    expect(
      eventbrite.decode(
        mail("orders@eventbrite.com", "Your Tickets for Charla Tres", "2036-04-12 15:33", "this is your order confirmation for Charla Tres Organized by Club Ejemplo Order Summary Order #: 1 Name Type Quantity Ana Admission Ticket 1")
      )
    ).toBeNull();
    expect(eventbrite.decode(mail("noreply@event.eventbrite.com", "Nosotros estamos tristes de verte ir", "2036-01-01 10:00", "Order total: CLP$1.000"))).toBeNull();
  });

  it("throws on a paid order not in pesos, or without a total", () => {
    expect(() => eventbrite.decode(paid("US$25.50"))).toThrow(/not pesos/);
    expect(() => eventbrite.decode(paid("$25.500"))).toThrow(/not pesos/);
    expect(() => eventbrite.decode(paid("CLP$25.500,50"))).toThrow(/centavos/);
    expect(() =>
      eventbrite.decode(mail("noreply@order.eventbrite.com", "Order Confirmation for X", "2036-01-01 10:00", "X 1 x General Order Summary Order #5 Ana 1 x General CLP$5.000"))
    ).toThrow(/without an order total/);
  });
});

describe("miCoca-Cola order confirmations", () => {
  it("reads the current «Hemos recibido tu pedido … con éxito!» layout", () => {
    const r = micoca.decode(
      mail(
        "contacto@micoca-cola.cl",
        "Hemos recibido tu pedido 9990001112223-01 con éxito!",
        "2036-09-26 12:30",
        "¡Hola Ana! Tu pago fue aprobado y tu compra ha sido confirmada Detalles del pedido Nº 9990001112223-01 Fecha de compra 26/09/2036 Recibe Ana Pérez Dirección Calle Uno 1, Santiago. Tipo de entrega Despacho a domicilio Medio de pago Visa Producto(s) Refill Bebida Retornable 24 x 237 ml. (No incluye envases) Cantidad: 2 $ 10.590 Vaso Transparente 495 ml. Cantidad: 2 $ 1.990 Subtotal: 25.160 Descuentos: -.800 Despacho: 3.490 Total: 27.850"
      )
    )!;
    expect(r).toMatchObject({
      processor: "micoca_cola",
      payee: { name: "miCoca-Cola.cl" },
      amount: 27850,
      paid_at_chile: "2036-09-26 12:30",
      order_ref: "9990001112223-01",
      concept: "Refill Bebida Retornable 24 x 237 ml. (No incluye envases) · Vaso Transparente 495 ml.",
      payment_method: "Visa",
    });
  });

  it("reads the 2020 «Pago Aprobado» layout with ungrouped amounts", () => {
    const r = micoca.decode(
      mail(
        "contacto@micoca-cola.cl",
        "Pago Aprobado - Pedido N°: 9990001112224-01",
        "2036-03-29 00:30",
        "Hola Ana, ¡El pago de tu pedido ha sido aprobado! Pedido nº: 9990001112224-01 Fecha de compra: 29/03/2036 Medio de Pago: Mastercard Datos de entrega: Recibe: Ana Detalle del Pedido Refill 8 Bebida 2,0 lt. 1 X $ 7790 Starter Kit Bebida 24 x 237 ml. 1 X $ 9490 Subtotal $ 17280 Descuentos $ -930 Despacho $ 1495 Total $ 17845 www.example.com"
      )
    )!;
    expect(r).toMatchObject({ amount: 17845, order_ref: "9990001112224-01", payment_method: "Mastercard", concept: "Refill 8 Bebida 2,0 lt. · Starter Kit Bebida 24 x 237 ml." });
  });

  it("skips an order still waiting for its payment, and status mails", () => {
    expect(
      micoca.decode(
        mail(
          "contacto@micoca-cola.cl",
          "Hemos recibido tu pedido de Refill 8 Bebida...  y 1 item(s)  con éxito!",
          "2036-03-29 00:30",
          "Recibimos tu pedido nº: 9990001112224 Medio de Pago: Mastercard Estamos esperando la confirmación del pago. Detalle del Pedido Refill 1 x $7790 Subtotal $ 7790 Descuentos $ 0 Despacho $ 1495 Total $ 9285"
        )
      )
    ).toBeNull();
    expect(micoca.decode(mail("contacto@micoca-cola.cl", "Pedido preparado y facturado", "2036-06-05 09:42", "Pedido nº: 1 Total $ 100"))).toBeNull();
    expect(micoca.decode(mail("contacto@micoca-cola.cl", "Tu pedido de Refill...  y 2 item(s)  fue CANCELADO.", "2036-06-24 13:33", "Total $ 29.260"))).toBeNull();
  });

  it("throws when the total does not add up or is missing", () => {
    const subject = "Hemos recibido tu pedido 9990001112225-01 con éxito!";
    const head = "Tu pago fue aprobado Detalles del pedido Nº 9990001112225-01 Medio de pago Visa Producto(s) Refill Cantidad: 1 $ 9.890 ";
    expect(() => micoca.decode(mail("contacto@micoca-cola.cl", subject, "2036-01-01 10:00", `${head}Subtotal: 9.890 Descuentos: 0 Despacho: 3.490 Total: 9.890`))).toThrow(/≠/);
    expect(() => micoca.decode(mail("contacto@micoca-cola.cl", subject, "2036-01-01 10:00", `${head}Subtotal: 9.890 Descuentos: 0 Despacho: 3.490`))).toThrow(/no Total/);
  });
});

describe("DynaVap order mails (dollars)", () => {
  const dynavap = shop("dynavap");
  it("reads the 2018–19 order confirmation: total in dollars, items without codes or coupon prices", () => {
    const r = dynavap.decode(
      mail(
        "info@dynavap.com",
        "DynaVap - Order Confirmation",
        "2036-03-15 20:24",
        'DynaVap - Order Confirmation Dear Persona, Thank you … Order Summary Order Date: 03/15/2036 PM 06:23 (GMT-6) Order Number: 031536ab Item Description Qty Price VCM 113-73-15-00.b The New "M" Coupon: X20 1 $ 70.00 $ 56 ATL-31 Torch Dos 2 $ 12.00 $ 9.6 Order Subtotal $ 82.00 $ 65.60 Coupon Value $ 16.40 Shipping Charges $ 13.00 Payment Method(s) Used: Credit Card Order Total $ 78.60 As always'
      )
    )!;
    expect(r).toMatchObject({ processor: "dynavap", currency: "usd", amount: 78.6, order_ref: "031536ab", concept: 'The New "M" × 1 · Torch Dos × 2', payment_method: "Credit Card" });
  });

  it("reads the 2020 receipt with item codes, and throws without a total", () => {
    const r = dynavap.decode(
      mail(
        "noreply@dynavap.com",
        "Thank you for your order with DynaVap",
        "2036-03-30 00:13",
        'Receipt Thank you for your order. Order Summary: Merchant DynaVap Order # 1234567890 Date Sun 29 Mar 2036 Payment Method xxxx xxxx xxxx 0000 Order Total $45.50 Items Item Price Qty Total Subtotal: $40.00 Shipping & Handling $5.50 Order Total: $45.50 Ring Kit Code : POT-1 Weight : 0.004 LBS $5.00 2 $10.00 The "M" Code : VCM 853-73-15-00.c Weight : 0.2 LBS 1 $30.00'
      )
    )!;
    expect(r).toMatchObject({ amount: 45.5, currency: "usd", order_ref: "1234567890", concept: 'Ring Kit × 2 · The "M" × 1', payment_method: "card 0000" });
    expect(() => dynavap.decode(mail("info@dynavap.com", "DynaVap - Order Confirmation", "2036-01-01 10:00", "Order Number: 1 Item Description Qty Price"))).toThrow(/order total/);
    expect(dynavap.decode(mail("info@dynavap.com", "DynaVap - Order Status Changed to Shipped", "2036-01-01 10:00", "x"))).toBeNull();
  });
});

describe("MercadoLibre order mails", () => {
  const ml = shop("mercadolibre");
  const order = (subject: string, text: string) => ml.decode(mail("info@mercadolibre.cl", subject, "2036-06-04 10:15", text));

  it("reads one charge in cuotas and names the seller", () => {
    const r = order(
      "Compraste Termoventilador Uno",
      "Pagaste $ 55.470 6x $ 9.245 sin intereses con tarjeta de crédito Visa terminada en 1234 Información del vendedor TIENDA UNO SPA RUT: 765432109 Válido como boleta"
    )!;
    expect(r).toMatchObject({
      processor: "mercadolibre",
      payee: { name: "TIENDA UNO SPA", rut: "765432109" },
      amount: 55470,
      installments: 6,
      charges: null,
      concept: "Termoventilador Uno",
      payment_method: "Visa crédito ·1234",
      paid_at_chile: "2036-06-04 10:15",
    });
  });

  it("reads an order from two sellers as two charges that add up to the total", () => {
    const r = order(
      "Compraste 2 productos",
      "Pagaste $ 15.725 1x $ 8.865 y 1x $ 6.860 con tarjeta de crédito Visa terminada en 1234 Información del vendedor TIENDA UNO RUT: 111111111 TIENDA DOS RUT: 222222222 Válido como boleta"
    )!;
    expect(r.charges).toEqual([
      { amount: 8865, installments: null },
      { amount: 6860, installments: null },
    ]);
    expect(r.payee).toMatchObject({ name: "TIENDA UNO, TIENDA DOS", rut: null });
  });

  it("reads a mail with no amount (2026 on) and one with no seller (before mid-2024)", () => {
    expect(order("Compraste Colgador", "Información del vendedor TIENDA UNO RUT: 111111111 Ver en mis compras")).toMatchObject({
      amount: null,
      installments: null,
      payee: { name: "TIENDA UNO" },
    });
    expect(order("Compraste Bálsamo", "Pagaste $ 13.174 con tarjeta de crédito Visa terminada en 1234 Ver en mis compras")).toMatchObject({
      amount: 13174,
      payee: { name: "Mercado Libre", rut: null },
    });
  });

  it("throws when the charges do not add up, or the mail states neither a payment nor a seller", () => {
    expect(() => order("Compraste X", "Pagaste $ 15.000 1x $ 8.865 y 1x $ 6.860 con tarjeta Ver en mis compras")).toThrow(/add up/);
    expect(() => order("Compraste X", "Gracias por tu compra")).toThrow(/neither/);
    expect(order("Tu envío está en camino", "…")).toBeNull();
  });
});

describe("Amazon shipment and order mails", () => {
  const ship = shop("amazon");
  const order = shop("amazon_order");
  const m = (subject: string, text: string) => mail("shipment-tracking@amazon.com", subject, "2036-03-08 04:34", text);

  it("reads each shipment layout's total and what shipped", () => {
    expect(
      ship.decode(m('Shipped: "OXO Good Grips 3 Piece..."', "Your package was shipped! Order # \u00e2\u00ab114-1740488-6053012 Track package OXO Good Grips 3 Piece Silicone S... Quantity: 1 $ 20 86 Pan Two Quantity: 2 $ 3 00 Total $26.86 Keep shopping for $16.95")),
    ).toMatchObject({ processor: "amazon", amount: 26.86, currency: "usd", order_ref: "114-1740488-6053012", concept: "OXO Good Grips 3 Piece Silicone S... × 1 · Pan Two × 2" });
    expect(
      ship.decode(m('Your Amazon.com order of "Layrite Natural Matte Cream..." and 1 more item has shipped!', "ON THE WAY Order #114-9735675-5002632 SHIP TO Cristian SHIPMENT TOTAL $38.93 Return or replace")),
    ).toMatchObject({ amount: 38.93, concept: "Layrite Natural Matte Cream... and 1 more item" });
    expect(ship.decode(m("Your Amazon.com order #112-3580852-0243415 has shipped", "Order #112-3580852-0243415 SHIPMENT TOTAL $30.34"))).toMatchObject({ amount: 30.34, concept: null });
    expect(ship.decode(m('Shipped: "Butchers Twine..."', "Order # 112-7026039-1170642 Track package Butchers Twine Quantity: 1 $ 6 99 Total $0.00"))).toBeNull();
    expect(ship.decode(m("Now arriving today: Your Amazon package will be delivered today.", "…"))).toBeNull();
    expect(() => ship.decode(m("Your Amazon.com order #1 has shipped", "Order #112-3580852-0243415 nothing"))).toThrow(/shipment total/);
  });

  it("reads an order confirmation's total and items, and skips the currency-converter ones", () => {
    expect(
      order.decode(m('Ordered: "MORFY Portable Blanket..."', "Order # \u00e2\u00ab112-6739429-2553830 View or edit order MORFY Portable Blanket Warmer, Co... Quantity: 1 $ 79 99 Grand Total: $95.19")),
    ).toMatchObject({ processor: "amazon_order", amount: 95.19, concept: "MORFY Portable Blanket Warmer, Co... × 1" });
    expect(
      order.decode(m('Your Amazon.com order of "KES Bathroom Shelf Tempered..." and 1 more item.', "Ship to: Cristian Santiago, Region Metropolitana Order # 114-1740488-6053012 View or manage order OXO Good Grips 3 Piece Sili... Qty : 1 Arriving: March 24 Ship to: Cristian Santiago, Region Metropolitana Order # 114-1740488-6053012 View or manage order KES Bathroom Shelf Tempered... Qty : 1 Order Total: $72.10")),
    ).toMatchObject({ amount: 72.1, concept: "OXO Good Grips 3 Piece Sili... × 1 · KES Bathroom Shelf Tempered... × 1" });
    expect(order.decode(m("Amazon.com order of Clea (Alexandria Quartet).", "Order # 109-8207594-6525020 Order Total: CLP 18.413"))).toBeNull();
    expect(order.decode(m('Your Amazon.com order of "Hygie Rinse..." and 2 more item(s) has been canceled.', "…"))).toBeNull();
    expect(order.decode(m("Your Amazon.com Order #114-6110261-6152233", "…"))).toBeNull();
  });
});
