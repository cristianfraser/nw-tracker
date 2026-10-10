import { describe, expect, it } from "vitest";
import { processorReceiptSchema } from "nw-tracker-contracts";
import { STAY_PROCESSORS } from "./stayMails.js";

const p = (slug: string) => STAY_PROCESSORS.find((x) => x.slug === slug)!;
const booking = p("booking");
const airbnb = p("airbnb");
const stripe = p("stripe");
const accor = p("accor");
let seq = 0;
const mail = (subject: string, sent: string, text: string, from = "noreply@example.test") => ({
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
/** UTF-8 read as Latin-1, as some archived mails come. */
const mojibake = (s: string) => Buffer.from(s, "utf8").toString("latin1");

describe("Booking.com confirmations", () => {
  const head = (city: string) => `Confirmation: 1234567890 PIN: 0000 Thanks Ana! Your booking in ${city} is confirmed.`;

  it("reads a booking Booking paid at once", () => {
    const text = `${head("Puerto Sur")} Reservation details Check-in Saturday 4 September 2034 (14:00 - 00:00) Check-out Sunday 5 September 2034 (05:00 - 10:00) Your reservation 1 night, 1 apartment Location Calle Uno 27, Old Town, Puerto Sur, 20000, Ruritania Phone +1 Price details Apartment € 99.56 Price € 112.50 Payment details You’ve paid € 112.50 for this booking 31 Aug 2034 •••• 1111 Paid € 112.50 Some charges will be collected by the property`;
    const r = valid(booking.decode(mail("🛄 Thanks! Your booking is confirmed at Casa Prueba", "2034-08-31 00:12", text))!);
    expect(r).toMatchObject({
      processor: "booking",
      payee: { name: "Casa Prueba" },
      amount: 112.5,
      currency: "eur",
      paid_at_chile: "2034-08-31 00:12",
      order_ref: "1234567890",
      concept: "Puerto Sur, 2034-09-04 → 2034-09-05 (1 noche)",
      stay: { check_in: "2034-09-04", check_out: "2034-09-05", city: "Puerto Sur" },
      payment_method: "••••1111",
      statement_descriptor: "Hotel at Booking.com",
      charges: null,
    });
  });

  it("reads a payment Booking scheduled, dated on its charge day", () => {
    const text = `${head("Villa Norte")} Check-in Monday, June 30, 2034 (from 2:00 PM) Check-out Thursday, July 3, 2034 (until 11:00 AM) Your reservation 3 nights Location 1 Plaza, Villa Norte, AB1 2CD, Ruritania Phone +1 Price details 1 Standard Studio £352.50 VAT £70.50 Total Price £423 Payment info You scheduled a payment for this booking, and we’ll charge your card automatically. Jun 27, 2034 •••• 2222 Scheduled £423 Pay now`;
    const r = valid(booking.decode(mail("🛄 Thanks! Your booking is confirmed at Estudios Prueba", "2034-06-01 00:34", text))!);
    expect(r).toMatchObject({ amount: 423, currency: "gbp", paid_at_chile: "2034-06-27 00:00", concept: "Villa Norte, 2034-06-30 → 2034-07-03 (3 noches)", payment_method: "••••2222", statement_descriptor: "Hotel at Booking.com" });
    expect(r.stay).toEqual({ check_in: "2034-06-30", check_out: "2034-07-03", city: "Villa Norte" });
  });

  it("reads a booking the property charges, in its currency, with the stay's dates", () => {
    const text = `${head("Bahía")} Your payment will be handled by Hotel Prueba. Check-in Friday 1 December 2034 (15:00 - 00:00) Check-out Sunday 3 December 2034 (00:00 - 10:00) Your reservation 2 nights Location 10 Calle, Bahía, 1010, Ruritania Phone +1 Prepayment You will be charged a prepayment of the total price at any time. Price details Classic Room NZD 297.94 15 % VAT is included. NZD 44.69 Total price NZD 342.63 Classic Room`;
    const r = valid(booking.decode(mail("🛄 Thanks! Your booking is confirmed at Hotel Prueba", "2034-11-30 08:14", text))!);
    expect(r).toMatchObject({ amount: 342.63, currency: "nzd", paid_at_chile: "2034-11-30 08:14", concept: "Bahía, 2034-12-01 → 2034-12-03 (2 noches)", payment_method: null, statement_descriptor: null });
    expect(r.stay).toEqual({ check_in: "2034-12-01", check_out: "2034-12-03", city: "Bahía" });
  });

  it("reads a stay paid at the property, priced in dollars", () => {
    const text = `${head("Ciudad Capital")} Your payment will be handled by Hotel Prueba. You'll pay when you stay at Hotel Prueba Reservation details Check-in Friday, October 6, 2034 (from 14:00) Check-out Sunday, October 8, 2034 (until 12:00) Location Calle 1, Ciudad Capital, 7520000, Ruritania Phone +1 Price details Superior Queen Room US$177.18 Price US$177.18 Superior Queen Room Cancellation cost from October 6, 2034 10:34 PM: US$88.59`;
    const r = valid(booking.decode(mail("🛄 Thanks! Your booking is confirmed at Hotel Prueba", "2034-10-06 22:34", text))!);
    expect(r).toMatchObject({ amount: 177.18, currency: "usd", concept: "Ciudad Capital, 2034-10-06 → 2034-10-08 (2 noches)", statement_descriptor: null });
    expect(r.stay).toEqual({ check_in: "2034-10-06", check_out: "2034-10-08", city: "Ciudad Capital" });
  });

  it("reads an update that took a second payment as two charges, its city from the address", () => {
    const text = `Confirmation number: 1234567890 PIN code: 0000 Your booking has been successfully modified Hotel Prueba Calle Dos, 22, Centro, Puerto Sur, 08010, Ruritania - Show directions Your reservation 5 nights, 1 room Check-in Wednesday 6 October 2034 (15:00 - 00:00) Check-out Monday 11 October 2034 (08:00 - 12:00) Studio € 450.43 Price € 450.43 Booking.com pays − € 23.83 Payment amount € 426.60 Payment information You got a € 228.74 refund for this booking. You've paid € 438.63 overall. 4 Oct 2034 •••• 1111 Refunded € 45.29 •••• 1111 Refunded € 183.45 4 Oct 2034 •••• 1111 Paid € 452.81 •••• 1111 Paid € 214.56 Some charges will be collected by the property`;
    const r = valid(booking.decode(mail("Your updated booking at Hotel Prueba", "2034-10-04 12:35", text))!);
    expect(r).toMatchObject({
      amount: 667.37,
      currency: "eur",
      charges: [
        { amount: 452.81, installments: null },
        { amount: 214.56, installments: null },
      ],
      concept: "Puerto Sur, 2034-10-06 → 2034-10-11 (5 noches)",
      stay: { check_in: "2034-10-06", check_out: "2034-10-11", city: "Puerto Sur" },
    });
  });

  it("leaves flights, messages and payment notices alone, and throws on a confirmation it cannot price", () => {
    expect(booking.decode(mail("Puerto Sur flight confirmation", "2034-08-16 20:39", "Your flight …"))).toBeNull();
    expect(booking.decode(mail("Payment successful", "2034-06-26 20:40", "Confirmation: 1234567890 Paid £423"))).toBeNull();
    const unpriced = `${head("Bahía")} Check-in Friday 1 December 2034 Check-out Sunday 3 December 2034 Location 10 Calle, Bahía, 1010, Ruritania Phone +1`;
    expect(() => booking.decode(mail("🛄 Thanks! Your booking is confirmed at Hotel Prueba", "2034-11-30 08:14", unpriced))).toThrow(/no price/);
  });
});

describe("Airbnb confirmations", () => {
  const zw = (s: string) => [...s].join("‌");

  it("reads the 2020 layout: the card's row, not the credit", () => {
    const text = `Your reservation is confirmed You’re going to Pueblo Sur! Casa del Lago Prueba Private room hosted by Ana Thursday, ${zw("6 February 2034 Check-in is flexible")} Friday, ${zw("7 February 2034 Checkout by 12:00 PM")} View full itinerary Payments Payment 1 of 2 $15,400 Jan 28, 2034 · 11:50PM -03 Referral Credit Payment 2 of 2 $8,242 Jan 28, 2034 · 11:50PM -03 MASTERCARD •••• 1111 Amount paid (CLP) $23,642 Reservation code HMTEST0001 Cancellation policy`;
    const r = valid(airbnb.decode(mail("Reservation confirmed for Pueblo Sur", "2034-01-28 23:50", text, "automated@airbnb.com"))!);
    expect(r).toMatchObject({
      processor: "airbnb",
      payee: { name: "Casa del Lago Prueba" },
      amount: 8242,
      currency: "clp",
      paid_at_chile: "2034-01-28 23:50",
      order_ref: "HMTEST0001",
      concept: "Pueblo Sur, 2034-02-06 → 2034-02-07 (1 noche)",
      stay: { check_in: "2034-02-06", check_out: "2034-02-07", city: "Pueblo Sur" },
      statement_descriptor: "AIRBNB * HMTEST0001",
      payment_method: "MASTERCARD ••••1111",
    });
  });

  it("reads the 2021 layout in pounds, its time on the zone it prints", () => {
    const text = mojibake(
      `Your reservation is confirmed You’re going to Valle Alto! Cabaña Prueba Entire home/flat hosted by Ana Friday, ${zw("20 August 2034 Check-in is flexible")} Sunday, ${zw("22 August 2034 Checkout by 1:00 PM")} Payments Payment 1 of 1 £260.46 Aug 15, 2034 · 05:32PM -04 MASTERCARD •••• 1111 Amount paid (GBP) £260.46 Reservation code HMTEST0002 Change reservation`
    );
    const r = valid(airbnb.decode(mail("Reservation confirmed for Valle Alto", "2034-08-15 17:32", text))!);
    expect(r).toMatchObject({ amount: 260.46, currency: "gbp", paid_at_chile: "2034-08-15 17:32", concept: "Valle Alto, 2034-08-20 → 2034-08-22 (2 noches)" });
    expect(r.stay).toEqual({ check_in: "2034-08-20", check_out: "2034-08-22", city: "Valle Alto" });
  });

  it("reads the 2023 layout, its year from the payment, across a new year", () => {
    const text = mojibake(
      `You’re all set for Costa Prueba You’re all set for Costa Prueba Quiet Prueba Getaway Entire home/flat hosted by Ana Check-in Mon, 30 Dec 14:00 Checkout Fri, 3 Jan 10:00 Address 1 Calle Payments MASTERCARD •••••1111 Dec 26, 2034 · 04:22 PM CLST $362.87 Amount paid (USD) $362.87 Change reservation Reservation code: HMTEST0003 Visit help centre`
    );
    const r = valid(airbnb.decode(mail("Reservation confirmed for Costa Prueba", "2034-12-26 16:22", text))!);
    expect(r).toMatchObject({ payee: { name: "Quiet Prueba Getaway" }, amount: 362.87, currency: "usd", paid_at_chile: "2034-12-26 16:22", concept: "Costa Prueba, 2034-12-30 → 2035-01-03 (4 noches)" });
    expect(r.stay).toEqual({ check_in: "2034-12-30", check_out: "2035-01-03", city: "Costa Prueba" });
  });

  it("decodes a stay paid with credit alone, and receipts and cancellations, to null; throws without a reservation code", () => {
    const creditOnly = `You’re going to Pueblo Sur! Casa Prueba Shared room hosted by Ana Thursday, 6 February 2034 Check-in Friday, 7 February 2034 Checkout Payments Payment 1 of 1 $15,400 Jan 28, 2034 · 11:50PM -03 Referral Credit Amount paid (CLP) $15,400 Reservation code HMTEST0004`;
    expect(airbnb.decode(mail("Reservation confirmed for Pueblo Sur", "2034-01-28 23:50", creditOnly))).toBeNull();
    expect(airbnb.decode(mail("Your receipt from Airbnb", "2034-01-28 23:58", "Total (CLP) $23,642"))).toBeNull();
    expect(airbnb.decode(mail("Airbnb Reservation Cancelled", "2034-02-01 23:32", "Total refund $39515 CLP"))).toBeNull();
    expect(() => airbnb.decode(mail("Reservation confirmed for Pueblo Sur", "2034-01-28 23:50", creditOnly.replace(/Reservation code \S+/, ""))))
      .toThrow(/no reservation code/);
  });
});

describe("Stripe receipts", () => {
  const text = (paid: string, charged: string) =>
    `Receipt from Gestora Prueba [#1234-5678] Amount paid ${paid} Date paid Nov 3, 2034, 3:13:51 PM ${mojibake("  ")} Receipt from Gestora Prueba Receipt #1234-5678 Amount paid ${paid} Date paid Nov 3, 2034, 3:13:51 PM Payment method - 1111 Summary Early check-in ${paid} Amount charged ${charged} If you have any questions … which partners with Stripe to provide invoicing and payment processing.`;

  it("reads the merchant, the amount in its currency and the card", () => {
    const r = valid(stripe.decode(mail("Your Gestora Prueba receipt [#1234-5678]", "2034-11-02 23:15", text("NZ$652.00", "NZ$652.00")))!);
    expect(r).toMatchObject({ processor: "stripe", payee: { name: "Gestora Prueba" }, amount: 652, currency: "nzd", order_ref: "#1234-5678", concept: "Early check-in", payment_method: "••••1111", paid_at_chile: "2034-11-02 23:15", stay: null });
  });

  it("throws when the amount paid and the amount charged disagree", () => {
    expect(() => stripe.decode(mail("Your Gestora Prueba receipt [#1234-5678]", "2034-11-02 23:15", text("NZ$652.00", "NZ$600.00")))).toThrow(/≠ amount charged/);
    expect(stripe.decode(mail("Thanks for applying to Stripe!", "2034-11-02 23:15", "…"))).toBeNull();
  });
});

describe("Accor confirmations", () => {
  it("reads what was paid at booking, not what is left for the hotel", () => {
    const text = `Booking number: ABCD1234 Your stay hotel Prueba Calle Larga 105 - 5026 RB VILLA PRUEBA - Ruritania reservations@example.test 31 13/0000000 Your reservation is confirmed. Date of stay: From 11 Jul 2034 to 15 Jul 2034 Your stay: 1 accommodation, 4 nights, 1 adult … Total price of stay Amount already paid: EUR 525.79 Remaining amount to be paid at the hotel: EUR 15.02 Fees and taxes: EUR 15.02 Total EUR 540.81 (fees and taxes included)`;
    const r = valid(accor.decode(mail("Confirmation of your reservation: hotel Prueba No.ABCD1234", "2034-12-07 22:59", text))!);
    expect(r).toMatchObject({ processor: "accor", payee: { name: "hotel Prueba" }, amount: 525.79, currency: "eur", order_ref: "ABCD1234", concept: "Villa Prueba, 2034-07-11 → 2034-07-15 (4 noches)" });
    expect(r.stay).toEqual({ check_in: "2034-07-11", check_out: "2034-07-15", city: "Villa Prueba" });
    expect(accor.decode(mail("Your online check-in is confirmed: hotel Prueba No. ABCD1234", "2034-07-10 06:07", text))).toBeNull();
    expect(() => accor.decode(mail("Confirmation of your reservation: hotel Prueba No.ABCD1234", "2034-12-07 22:59", text.replace(/Date of stay.+?adult/, "")))).toThrow(/no dates of stay/);
  });
});
