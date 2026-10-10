import { describe, expect, it } from "vitest";
import { processorReceiptSchema } from "nw-tracker-contracts";
import { UBER_PROCESSORS } from "./uberMails.js";

const p = (slug: string) => UBER_PROCESSORS.find((x) => x.slug === slug)!;
const trips = p("uber");
const tripSummaries = p("uber_trip_summary");
const eats = p("uber_eats");
const eatsSummaries = p("uber_eats_summary");
const one = p("uber_one");
let seq = 0;
const mail = (subject: string, sent: string, text: string, from = "noreply@uber.com") => ({
  message_id: `<${sent}-${++seq}@test>`,
  sent_at_chile: sent,
  from,
  subject,
  text,
});
const valid = <T>(r: T) => {
  expect(processorReceiptSchema.safeParse(r).success).toBe(true);
  return r;
};

describe("Uber trip mails", () => {
  it("reads the 2014 «Receipt #» layout (Chilean amounts) and drops a ride paid by credit", () => {
    const body = (charged: string) =>
      `Receipt # ABCD-03-2034-0000001 Receipt issued on: March 3, 2034 at 03:16am Thanks for riding Uber! Billed To Ana Prueba Trip Request Date March 3, 2034 at 02:43am Pickup Location Calle Uno 100, Ñuñoa, Chile Dropoff Location Calle Dos 200, Peñalolén, Chile Payment Personal Visa - 1111 Amount Charged ${charged} Driver Juan Fare Breakdown Total Fare $4.179,00 Trip Statistics Distance 7.41 kilometers Duration 14 minutes xidabcdefgh`;
    const r = valid(trips.decode(mail("Uber Ride Receipt", "2034-03-03 03:16", body("$4.179,00"), "apoyosantiago@uber.com"))!);
    expect(r).toMatchObject({
      processor: "uber",
      amount: 4179,
      currency: "clp",
      paid_at_chile: "2034-03-03 02:43",
      order_ref: "xidabcdefgh",
      payment_method: "Visa ••••1111",
      trip: { from: "Calle Uno 100, Ñuñoa, Chile", to: "Calle Dos 200, Peñalolén, Chile", started_at_chile: "2034-03-03 02:43", ended_at_chile: null, distance_km: 7.41 },
    });
    expect(trips.decode(mail("Uber Ride Receipt", "2034-03-03 03:16", body("$0,00")))).toBeNull();
  });

  it("reads the 2014–2016 layout in US-grouped CLP and in Chilean-grouped «$»", () => {
    const r = valid(
      trips.decode(
        mail(
          "Your Saturday evening trip with Uber",
          "2036-05-21 20:13",
          "May 21, 2036 CLP2,051.00 Thanks for choosing Uber, Ana 08:03pm Calle Tres 5, Viña del Mar, Chile 08:12pm Calle Cuatro 9, Viña del Mar, Chile CAR uberX kilometers 2.19 TRIP TIME 00:09:18 FARE BREAKDOWN Base Fare 600,00 Subtotal CLP2,051.00 CHARGED Personal 2222 CLP2,051.00 Visit the trip page xid11111111-2222-3333-4444-555555555555 abc"
        )
      )!
    );
    expect(r).toMatchObject({
      amount: 2051,
      paid_at_chile: "2036-05-21 20:12",
      order_ref: "xid11111111-2222-3333-4444-555555555555",
      concept: "UberX · 2,19 km",
      payment_method: "••••2222",
      trip: { started_at_chile: "2036-05-21 20:03", ended_at_chile: "2036-05-21 20:12", distance_km: 2.19 },
    });
    const split = trips.decode(
      mail(
        "Your Wednesday evening trip with Uber",
        "2036-06-15 20:41",
        "June 15, 2036 $2.570,00 Thanks for choosing Uber, Ana 08:17pm Calle Cinco 1, Ñuñoa, Chile 08:40pm Calle Seis 2, Peñalolén, Chile CAR uberX kilometers 7.87 TRIP TIME 00:23:31 Total $5.140,00 Paid By Otra 2.570,00 CHARGED Personal 2222 $2.570,00 xid11111111-2222-3333-4444-666666666666"
      )
    )!;
    expect(split.amount).toBe(2570);
  });

  it("reads the 2016–2018 piped layout with US-grouped «$» and an end past midnight", () => {
    const r = valid(
      trips.decode(
        mail(
          "Your Sunday evening trip with Uber",
          "2037-12-31 21:27",
          "$4,074 Thanks for choosing Uber, Ana December 31, 2037 | uberX | Surge x2.3 11:58pm | Calle Siete 10, Ñuñoa, Chile 12:07am | Calle Ocho 20, Santiago, Chile You rode with Pedro 3.70 kilometers 00:08:20 Trip time uberX Car Your Fare Subtotal $3,962 CHARGED $4,074 Personal 3333 xid22222222-2222-3333-4444-555555555555"
        )
      )!
    );
    expect(r).toMatchObject({
      amount: 4074,
      paid_at_chile: "2038-01-01 00:07",
      payment_method: "••••3333",
      trip: { from: "Calle Siete 10, Ñuñoa, Chile", to: "Calle Ocho 20, Santiago, Chile", started_at_chile: "2037-12-31 23:58", ended_at_chile: "2038-01-01 00:07", distance_km: 3.7 },
    });
  });

  it("reads the 2018–2020 «Total:» layout, with credit taking part of the fare", () => {
    const r = valid(
      trips.decode(
        mail(
          "[Personal] Your Tuesday afternoon trip with Uber",
          "2039-03-26 13:45",
          "Total: $7,488 Tue, Mar 26, 2039 Thanks for riding, Ana We hope you enjoyed your ride this afternoon. Total $7,488 Trip Fare $5,521 Amount Charged Credits $2,200 4444 $5,288 Visit the trip page xid33333333-2222-3333-4444-555555555555 abc You rode with Pedro All your trips are insured. Learn more. UberX 12.97 km | 24 min 01:21pm Calle Nueve 1, San Miguel, Chile 01:45pm Calle Diez 2, Providencia, Chile Invite your friends"
        )
      )!
    );
    expect(r).toMatchObject({ amount: 5288, payment_method: "••••4444", paid_at_chile: "2039-03-26 13:45", concept: "UberX · 12,97 km" });
  });

  it("pairs a 2020–2025 summary with its receipt by the trip's own start", () => {
    const ride = "UberX 8.72 kilometers | 11 min 2:11 AM Calle Once 3, Valparaíso, Chile 2:22 AM Calle Doce 4, Viña del Mar, Chile Report lost item";
    const summary = valid(
      tripSummaries.decode(
        mail(
          "[Personal] Your Friday morning trip with Uber",
          "2042-07-08 02:22",
          `Total CLP 4,877 July 8, 2042 Thanks for riding, Ana Total CLP 4,877 Trip fare CLP 4,295 Booking Fee CLP 582 Download PDF This is not a payment receipt. It is a trip summary to acknowledge the completion of the trip. You rode with Pedro ${ride}`
        )
      )!
    );
    const receipt = valid(
      trips.decode(
        mail(
          "[Personal] Your Friday morning trip with Uber",
          "2042-07-08 11:06",
          `Total CLP 4,877 July 8, 2042 Thanks for riding, Ana Total CLP 4,877 Trip fare CLP 4,295 Payments Mastercard ••••5555 7/8/42 11:05 AM CLP 4,877 Visit the trip page Download PDF You rode with Pedro ${ride}`
        )
      )!
    );
    expect(summary).toMatchObject({ processor: "uber_trip_summary", amount: 4877, paid_at_chile: "2042-07-08 02:22" });
    expect(receipt).toMatchObject({
      processor: "uber",
      amount: 4877,
      paid_at_chile: "2042-07-08 11:05",
      payment_method: "Mastercard ••••5555",
      trip: { from: "Calle Once 3, Valparaíso, Chile", to: "Calle Doce 4, Viña del Mar, Chile", started_at_chile: "2042-07-08 02:11", ended_at_chile: "2042-07-08 02:22", distance_km: 8.72 },
    });
    expect(receipt.order_ref).toBe("uber-trip:2042-07-08 02:11");
    expect(summary.order_ref).toBe(receipt.order_ref);
    // Each slug reads only its own kind.
    expect(trips.decode(mail("[Personal] Your Friday morning trip with Uber", "2042-07-08 02:22", "Total CLP 1 July 8, 2042 This is not a payment receipt."))).toBeNull();
  });

  it("pairs a 2025-on summary with its receipt by the header's request time", () => {
    const head = "Sep 13, 2046 11:50 PM Sep 13, 2046 , 11:50 PM";
    const summary = valid(
      tripSummaries.decode(
        mail(
          "[Personal] Your Saturday evening trip with Uber",
          "2046-09-14 00:20",
          `${head} This is your charge summary Total CLP 10,499 This is not a payment receipt. It is a charge summary. Trip fare CLP 9,614 Need help?`
        )
      )!
    );
    const receipt = valid(
      trips.decode(
        mail(
          "[Personal] Your Saturday evening trip with Uber",
          "2046-09-14 12:52",
          `${head} Thanks for riding, Ana Total CLP 10,499 Payments Visa ••••6666 CLP 10,499 9/14/46 12:51 PM Want to switch? Trip details Priority 7.91 kilometers, 15 minutes 11:57 PM Calle Trece 12, Providencia 12:13 AM Calle Catorce 100, Santiago 11:57 PM Calle Trece 12, Providencia 12:13 AM Calle Catorce 100, Santiago You rode with Pedro`
        )
      )!
    );
    expect(summary).toMatchObject({ amount: 10499, trip: null, order_ref: "uber-trip:2046-09-13 23:50" });
    expect(receipt).toMatchObject({
      amount: 10499,
      paid_at_chile: "2046-09-14 12:51",
      payment_method: "Visa ••••6666",
      order_ref: "uber-trip:2046-09-13 23:50",
      concept: "Priority · 7,91 km",
      trip: { from: "Calle Trece 12, Providencia", to: "Calle Catorce 100, Santiago", started_at_chile: "2046-09-13 23:57", ended_at_chile: "2046-09-14 00:13" },
    });
  });

  it("reads a cancellation fee", () => {
    const r = valid(
      trips.decode(
        mail(
          "[Personal] Receipt for canceled trip on Tuesday afternoon",
          "2039-03-26 12:53",
          "Cancellation Fee: $1,100 Tue, Mar 26, 2039 We'll connect another time, Ana Here's the receipt for your canceled trip. Total $1,100 Amount Charged 4444 | Switch $1,100 Visit the trip page xid44444444-2222-3333-4444-555555555555 abc UberX Ride cancelled 12:47pm Request accepted 12:53pm Request canceled Invite"
        )
      )!
    );
    expect(r).toMatchObject({ amount: 1100, paid_at_chile: "2039-03-26 12:53", concept: "Uber · cancellation fee", trip: null });
  });

  it("decodes a ride charged in another currency to null", () => {
    expect(
      trips.decode(
        mail(
          "[Personal] Your Tuesday afternoon trip with Uber",
          "2041-10-12 13:36",
          "Total R$20.44 October 12, 2041 Thanks for riding, Ana Total R$20.44 Amount Charged 7777 | Switch R$20.44 You rode with Pedro UberX 5.10 kilometers | 12 min 1:10 PM Rua Um, Rio 1:22 PM Rua Dois, Rio Report lost item"
        )
      )
    ).toBeNull();
  });

  it("throws on a receipt it cannot read: no payment, or a bare «$» where the layout names currencies", () => {
    expect(() =>
      trips.decode(mail("[Personal] Your Monday trip with Uber", "2042-01-01 10:00", "Total CLP 4,000 January 1, 2042 Thanks for riding, Ana Total CLP 4,000 Report lost item"))
    ).toThrow(/no payment listed/);
    expect(() =>
      trips.decode(
        mail("[Personal] Your Monday trip with Uber", "2042-01-01 10:00", "Total CLP 4,000 January 1, 2042 Thanks Payments Visa ••••6666 1/1/42 10:00 AM $4,000 Report lost item")
      )
    ).toThrow();
  });
});

describe("Uber Eats mails", () => {
  it("only reads order subjects", () => {
    expect(eats.wantSubject("[Personal] Your Thursday afternoon order with Uber Eats")).toBe(true);
    expect(eats.wantSubject("Your Saturday afternoon grocery order with Uber")).toBe(true);
    expect(eats.wantSubject("Uber Careers: Thank you for your application for Software Engineer - Uber Eats")).toBe(false);
  });

  it("takes the card's part of an order split with Uber Cash", () => {
    const r = valid(
      eats.decode(
        mail(
          "[Personal] Your Thursday afternoon order with Uber Eats",
          "2045-01-02 15:38",
          "Total CLP 8,200 January 2, 2045 Thanks for being an Uber One member, Ana Here's your receipt for Hamburguesas Prueba (Centro). Rate order Rate order Total CLP 8,200 To view your full receipt go to Uber Eats Payments Uber Cash 1/2/45 3:35 PM CLP 2,799 Visa ••••8888 1/2/45 3:38 PM CLP 5,401 Visit the order page xid55555555-2222-3333-4444-555555555555 abc You ordered from Hamburguesas Prueba (Centro) Delivered to Calle 1"
        )
      )!
    );
    expect(r).toMatchObject({
      processor: "uber_eats",
      payee: { name: "Hamburguesas Prueba (Centro)", rut: null, email: null },
      amount: 5401,
      paid_at_chile: "2045-01-02 15:38",
      order_ref: "xid55555555-2222-3333-4444-555555555555",
      payment_method: "Visa ••••8888",
      charges: null,
    });
  });

  it("reads the items of the 2018–2020 layout, and the extra of an updated receipt", () => {
    const order = valid(
      eats.decode(
        mail(
          "Your Thursday evening order with Uber Eats",
          "2038-11-08 21:14",
          "Total: $15,600 Thu, Nov 08, 2038 Thanks for ordering, Ana Here's your receipt for Pizzería Prueba. Total $15,600 1 Pizza Grande $12,000 1 Bebida $2,200 Subtotal $14,200 Delivery Fee $1,400 Amount Charged 9999 | Switch $15,600 Visit the trip page xid66666666-2222-3333-4444-555555555555 abc You ordered from Pizzería Prueba Picked up from Calle 2"
        )
      )!
    );
    expect(order).toMatchObject({ amount: 15600, concept: "1 Pizza Grande · 1 Bebida", payee: { name: "Pizzería Prueba" }, paid_at_chile: "2038-11-08 21:14" });
    const extra = valid(
      eats.decode(
        mail(
          "Thanks for giving an extra! We’ve updated your Thursday evening order receipt",
          "2038-11-08 22:14",
          "Total: $16,100 Thu, Nov 08, 2038 Thanks for giving an extra to your order, Ana Here's your updated receipt for Pizzería Prueba. Total $16,100 1 Pizza Grande $12,000 Subtotal $12,000 Extra (gratuity granted by user) $500 Amount Charged 9999 | Switch $15,600 9999 | Switch $500 Visit the trip page xid66666666-2222-3333-4444-555555555555 abc You ordered from Pizzería Prueba"
        )
      )!
    );
    expect(extra).toMatchObject({ amount: 500, concept: "Tip or adjustment", order_ref: order.order_ref });
  });

  it("an order mailed again with its tip carries only the tip", () => {
    const r = valid(
      eats.decode(
        mail(
          "[Personal] Your Sunday morning order with Uber Eats",
          "2041-05-23 14:18",
          "Total CLP 8,001 May 23, 2041 Thanks for ordering, Ana Here's your receipt for Hamburguesas Prueba. Total CLP 8,001 To view your full receipt go to Uber Eats Payments Mastercard ••••7777 5/23/41 1:18 PM CLP 7,274 Mastercard ••••7777 5/23/41 2:18 PM CLP 727 Visit the order page xid77777777-2222-3333-4444-555555555555 You ordered from Hamburguesas Prueba"
        )
      )!
    );
    expect(r).toMatchObject({ amount: 727, paid_at_chile: "2041-05-23 14:18", charges: null });
  });

  it("an order the card was charged for in two pieces carries both", () => {
    const r = valid(
      eats.decode(
        mail(
          "[Personal] Your Saturday evening order with Uber Eats",
          "2045-01-04 19:16",
          "Total CLP 15,919 January 4, 2045 Thanks for being an Uber One member, Ana Here's your receipt for Supermercado Prueba (Centro). Rate order Rate order Total CLP 15,919 To view your full receipt go to Uber Eats Payments Visa ••••8888 1/4/45 7:09 PM CLP 3,841 Visa ••••8888 1/4/45 7:16 PM CLP 12,078 Visit the order page xid88888888-2222-3333-4444-555555555555 You ordered from Supermercado Prueba (Centro)"
        )
      )!
    );
    expect(r).toMatchObject({ amount: 15919, charges: [{ amount: 3841, installments: null }, { amount: 12078, installments: null }] });
  });

  it("a refund to Uber Cash, and an order paid in full with Uber Cash, decode to null", () => {
    expect(
      eats.decode(
        mail(
          "[Personal] Your Monday afternoon order with Uber Eats",
          "2043-02-06 14:10",
          "Total CLP 1,650 February 6, 2043 Thanks for ordering, Ana We updated your receipt for Pollos Prueba. Total CLP 1,650 Your refund has been applied. Payments Mastercard ••••7777 2/6/43 2:08 PM CLP 7,640 Uber Cash 2/6/43 2:09 PM -CLP 5,990 Refund Adjustment: CLP 0 You ordered from Pollos Prueba"
        )
      )
    ).toBeNull();
    expect(
      eats.decode(
        mail(
          "[Personal] Your Monday afternoon order with Uber Eats",
          "2043-02-07 14:10",
          "Total CLP 5,000 February 7, 2043 Thanks for ordering, Ana Here's your receipt for Pollos Prueba. Total CLP 5,000 Payments Uber Cash 2/7/43 2:09 PM CLP 5,000 You ordered from Pollos Prueba"
        )
      )
    ).toBeNull();
  });

  it("reads the 2025-on layout and a 2021 order summary", () => {
    const r = valid(
      eats.decode(
        mail(
          "Your Sunday afternoon order with Uber Eats",
          "2045-11-16 17:25",
          "Nov 16, 2045 3:27 PM Tip Nov 16, 2045 , 3:27 PM Thanks for tipping, Ana Here's your receipt for Bar Prueba (Lira). Total CLP 13,609 To view your full receipt go to Uber Eats Payments Visa ••••8888 CLP 13,609 11/16/45 5:25 PM Want to switch your payment method? Order completed Nov 16, 2045 at 4:11 PM"
        )
      )!
    );
    expect(r).toMatchObject({ payee: { name: "Bar Prueba (Lira)" }, amount: 13609, paid_at_chile: "2045-11-16 17:25", order_ref: "uber-order:2045-11-16 15:27", concept: null });
    const s = valid(
      eatsSummaries.decode(
        mail(
          "[Personal] Your Sunday evening order with Uber Eats",
          "2041-06-06 18:05",
          "Total CLP 8,688 June 6, 2041 Thanks for ordering, Ana Here's your receipt for Hamburguesas Prueba. Total CLP 8,688 To view your full receipt go to Uber Eats Amount Charged 7777 | Switch CLP 8,688 Visit the trip page xid99999999-2222-3333-4444-555555555555 Download PDF > This is not a payment receipt. It is an order summary. You ordered from Hamburguesas Prueba"
        )
      )!
    );
    expect(s).toMatchObject({ processor: "uber_eats_summary", amount: 8688, order_ref: "xid99999999-2222-3333-4444-555555555555" });
  });

  it("throws on an order mail that names no shop", () => {
    expect(() =>
      eats.decode(mail("[Personal] Your Sunday evening order with Uber Eats", "2041-06-06 18:05", "Total CLP 8,688 June 6, 2041 Thanks Payments Visa ••••8888 6/6/41 6:05 PM CLP 8,688"))
    ).toThrow(/no shop named/);
  });
});

describe("Uber One mails", () => {
  it("reads the monthly charge as a subscription", () => {
    const r = valid(
      one.decode(
        mail(
          "Uber One payment confirmation",
          "2043-02-07 13:59",
          "Your Uber One payment was successful Total charged (includes VAT tax) CLPÂ 3,990 Payment method Mastercard â\u0080¢â\u0080¢â\u0080¢â\u0080¢2468 Valid until Mar 8, 2043 at 1:54 PM *Benefits …",
          "uberone@uber.com"
        )
      )!
    );
    expect(r).toMatchObject({ processor: "uber_one", payee: { name: "Uber" }, amount: 3990, concept: "Uber One", payment_method: "Mastercard ••••2468", subscription: true, paid_at_chile: "2043-02-07 13:59" });
  });

  it("throws when the charge is not where it should be", () => {
    expect(() => one.decode(mail("Uber One payment confirmation", "2043-02-07 13:59", "Your Uber One payment was successful"))).toThrow(/no total charged/);
  });
});
