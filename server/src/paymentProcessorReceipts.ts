/**
 * Payment processors' receipts (`payment.processor_receipts`): who a charge that names only the
 * processor («PAGOS.FLOW.CL (WEB)», «PAGO FACIL») actually paid, and for what.
 *
 * The receipts are stored as mailed; which expense line each describes is derived every time the
 * expense lines are built, because a card line's id changes on every statement re-import. Pairing
 * keys on the line's purchase key and the receipt's pesos and payment day; see `matchPaymentReceipts`.
 */
import { createHash } from "node:crypto";
import type { PaymentProcessorReceiptsPayload, ProcessorReceipt, ReceiptStay, ReceiptTrip } from "nw-tracker-contracts";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { db } from "./db.js";
import { fxRowOnOrBefore } from "./fxRates.js";
import { deriveMerchantChargeLinks } from "./merchantExpenseNotes.js";

const COLUMNS = [
  "message_id",
  "processor",
  "sent_at_chile",
  "paid_at_chile",
  "payee_name",
  "payee_rut",
  "payee_email",
  "amount",
  "currency",
  "order_ref",
  "concept",
  "statement_descriptor",
  "payment_method",
  "installments",
  "trip_from",
  "trip_to",
  "trip_started_at_chile",
  "trip_ended_at_chile",
  "trip_distance_km",
  "subscription",
  "stay_check_in",
  "stay_check_out",
  "stay_city",
] as const;

type ReceiptRow = Record<(typeof COLUMNS)[number], string | number | null>;

function receiptRow(r: ProcessorReceipt): ReceiptRow {
  return {
    message_id: r.message_id,
    processor: r.processor,
    sent_at_chile: r.sent_at_chile,
    paid_at_chile: r.paid_at_chile,
    payee_name: r.payee.name,
    payee_rut: r.payee.rut,
    payee_email: r.payee.email,
    amount: r.amount,
    currency: r.currency,
    order_ref: r.order_ref,
    concept: r.concept,
    statement_descriptor: r.statement_descriptor,
    payment_method: r.payment_method,
    installments: r.installments,
    trip_from: r.trip?.from ?? null,
    trip_to: r.trip?.to ?? null,
    trip_started_at_chile: r.trip?.started_at_chile ?? null,
    trip_ended_at_chile: r.trip?.ended_at_chile ?? null,
    trip_distance_km: r.trip?.distance_km ?? null,
    subscription: r.subscription ? 1 : 0,
    stay_check_in: r.stay?.check_in ?? null,
    stay_check_out: r.stay?.check_out ?? null,
    stay_city: r.stay?.city ?? null,
  };
}

function hash(row: ReceiptRow): string {
  return createHash("sha256")
    .update(JSON.stringify(COLUMNS.map((c) => row[c])))
    .digest("hex");
}

type StoredCharge = { amount: number; installments: number | null };

const loadCharges = () =>
  db.prepare(`SELECT amount, installments FROM payment_receipt_charges WHERE message_id = ? ORDER BY position`);

/** Stores the receipts; a receipt already stored must state the same, its charges included. */
export function storePaymentProcessorReceipts(payload: PaymentProcessorReceiptsPayload): { received: number; new_receipts: number } {
  const existing = db.prepare(`SELECT ${COLUMNS.join(", ")} FROM payment_processor_receipts WHERE message_id = ?`);
  const insert = db.prepare(
    `INSERT INTO payment_processor_receipts (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`
  );
  const insertCharge = db.prepare(
    `INSERT INTO payment_receipt_charges (message_id, position, amount, installments) VALUES (?, ?, ?, ?)`
  );
  const charges = loadCharges();
  return db.transaction(() => {
    let added = 0;
    for (const r of payload.receipts) {
      const row = receiptRow(r);
      const old = existing.get(r.message_id) as ReceiptRow | undefined;
      if (old) {
        const oldCharges = JSON.stringify(charges.all(r.message_id) as StoredCharge[]);
        const newCharges = JSON.stringify((r.charges ?? []).map((c) => ({ amount: c.amount, installments: c.installments })));
        if (hash(old) !== hash(row) || oldCharges !== newCharges) {
          throw new Error(`payment receipt ${r.message_id} was already stored with other content`);
        }
        continue;
      }
      insert.run(row);
      (r.charges ?? []).forEach((c, i) => insertCharge.run(r.message_id, i + 1, c.amount, c.installments));
      added++;
    }
    return { received: payload.receipts.length, new_receipts: added };
  }).immediate();
}

/** What an expense line shows of the receipt that paid it. */
export type PaymentReceiptDto = {
  processor: string;
  /** The processor's brand, as it signs its mails. */
  processor_name: string;
  payee: string;
  payee_rut: string | null;
  payee_email: string | null;
  concept: string | null;
  order_ref: string | null;
  /** Chile clock, `YYYY-MM-DD HH:MM`. */
  paid_at_chile: string;
  statement_descriptor: string | null;
  installments: number | null;
  /** Which of a split payment's charges this line is (null when the payment was one charge). */
  charge: { position: number; of: number } | null;
  /** Inferred (a subscription's billing cycle, a monthly run), not read off a receipt. */
  guess: boolean;
  /** What the link rests on («receipt 2026-05-02», «subscription renewal notice», «monthly run»). */
  basis: string | null;
  /** The ride the charge paid for (Uber), as the receipt prints it. */
  trip: ReceiptTrip | null;
  /** The ride for the line: each address up to its first comma («Calle Uno 10 → Calle Dos 20»). */
  trip_label: string | null;
  /** The charge is a subscription's (a renewing App Store item, Uber One). */
  subscription: boolean;
};

export type StoredPaymentReceipt = Omit<PaymentReceiptDto, "processor_name" | "guess" | "basis" | "charge" | "trip" | "trip_label" | "subscription"> & {
  trip?: ReceiptTrip | null;
  subscription?: boolean;
  /** A lodging receipt's stay: a stay the property charges pairs within its window. */
  stay?: ReceiptStay | null;
  /** When the mail was sent (Chile clock): which of a reservation's mails is the latest. */
  sent_at_chile?: string;
  /** Set when the pairing is inferred, not an exact amount: what it rests on. */
  guess_basis?: string;
  message_id: string;
  /** Null when the document states none: it pairs by its day and the charge's name. */
  amount: number | null;
  /** ISO 4217, lowercase: pesos, dollars, or the local currency of a receipt abroad. */
  currency: string;
  /** The separate charges the payment was taken as; absent or empty = one charge of `amount`. */
  charges?: StoredCharge[];
};

export function loadPaymentProcessorReceipts(): StoredPaymentReceipt[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM payment_processor_receipts ORDER BY paid_at_chile, message_id`)
    .all() as ReceiptRow[];
  const chargesByReceipt = new Map<string, StoredCharge[]>();
  for (const c of db
    .prepare(`SELECT message_id, amount, installments FROM payment_receipt_charges ORDER BY message_id, position`)
    .all() as (StoredCharge & { message_id: string })[]) {
    const list = chargesByReceipt.get(c.message_id) ?? [];
    list.push({ amount: c.amount, installments: c.installments });
    chargesByReceipt.set(c.message_id, list);
  }
  return rows.map((r) => ({
    charges: chargesByReceipt.get(String(r.message_id)) ?? [],
    message_id: String(r.message_id),
    sent_at_chile: String(r.sent_at_chile),
    processor: String(r.processor),
    payee: String(r.payee_name),
    payee_rut: (r.payee_rut as string | null) ?? null,
    payee_email: (r.payee_email as string | null) ?? null,
    concept: (r.concept as string | null) ?? null,
    order_ref: (r.order_ref as string | null) ?? null,
    paid_at_chile: String(r.paid_at_chile),
    statement_descriptor: (r.statement_descriptor as string | null) ?? null,
    installments: (r.installments as number | null) ?? null,
    amount: r.amount == null ? null : Number(r.amount),
    currency: receiptCurrency(r),
    trip:
      r.trip_from == null
        ? null
        : {
            from: String(r.trip_from),
            to: String(r.trip_to),
            started_at_chile: (r.trip_started_at_chile as string | null) ?? null,
            ended_at_chile: (r.trip_ended_at_chile as string | null) ?? null,
            distance_km: r.trip_distance_km == null ? null : Number(r.trip_distance_km),
          },
    subscription: r.subscription === 1,
    stay:
      r.stay_check_in == null
        ? null
        : { check_in: String(r.stay_check_in), check_out: String(r.stay_check_out), city: (r.stay_city as string | null) ?? null },
  }));
}

function receiptCurrency(r: ReceiptRow): string {
  if (typeof r.currency !== "string" || !/^[a-z]{3}$/.test(r.currency)) throw new Error(`payment receipt ${r.message_id}: currency ${r.currency}`);
  return r.currency;
}

/** The expense-line fields the pairing reads. */
export type ReceiptCandidateLine = {
  source: string;
  purchase_key: string;
  amount_clp: number;
  /** A dollar charge's dollars (the card's dollar side). */
  amount_usd?: number | null;
  /** A dollar charge's amount in its own currency, as the statement prints it. */
  amount_orig?: number | null;
  /** That amount's currency when the statement labels it (pesos, dollars); null for any other. */
  amount_orig_currency?: "clp" | "usd" | null;
  /** The purchase's own day (a card line's transaction date). */
  purchase_on: string | null;
  merchant: string | null;
  line_role?: string | null;
  /**
   * An interest-bearing installment plan's printed principal (its total line carries principal +
   * interest): what the processor charged, so the receipt states this figure.
   */
  principal_clp?: number | null;
};

/** How a processor's charges read on a statement; prefers such a line when several fit. */
const PROCESSOR_MERCHANT_HINT: Record<string, RegExp> = {
  flow: /FLOW/i,
  pago_facil: /PAGO\s*FACIL/i,
  mercadolibre: /MERCADO\s*LIBRE|MERCADO\s*PAGO|MERPAGO|^MP\s*\*/i,
  amazon: /AMAZON|AMZN/i,
  amazon_order: /AMAZON|AMZN/i,
  uber: /UBER/i,
  uber_trip_summary: /UBER/i,
  uber_eats: /UBER/i,
  uber_one: /UBER/i,
  uber_eats_summary: /UBER/i,
  latam: /LATAM|\bLAN\b|LANCHILE|LAN\.COM/i,
  latam_change: /LATAM|\bLAN\b|LANCHILE|LAN\.COM/i,
  booking: /BOOKING/i,
  airbnb: /AIRBNB/i,
  accor: /ACCOR|IBIS|NOVOTEL|MERCURE|PULLMAN|SOFITEL/i,
};

/**
 * How a shop's own charges read on a statement, for a document that states no amount: the line
 * must carry this name. Stricter than the hint above — «MERPAGO*STREAT BURGER» is MercadoPago at a
 * restaurant, not a MercadoLibre order; an order reads «MP *MERCADO LIBRE», «MERPAGO*MERCADOLIBRE»
 * or «MERCADOPAGO*2PRODUCTOS» (an order from several sellers).
 */
const STATEMENT_NAME_FOR_AMOUNTLESS: Record<string, RegExp> = {
  mercadolibre: /MERCADO\s*LIBRE|\*\s*\d+\s*PRODUCTOS\b/i,
};

/**
 * A MercadoPago charge named after the seller («MERCADOPAGO *JIOR», «MERPAGO*NUEVOGENESISSPA»,
 * since 2024): its name after the «*» is the start of a seller the document names (letters and
 * digits only, at least four).
 */
const SELLER_NAMED_CHARGE: Record<string, RegExp> = {
  mercadolibre: /^(?:MERCADO\s*PAGO|MERPAGO|MP)\s*\*\s*(.+)$/i,
};

const lettersAndDigits = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

function chargeNamesSeller(r: StoredPaymentReceipt, merchant: string): boolean {
  const tail = SELLER_NAMED_CHARGE[r.processor]?.exec(merchant.trim())?.[1];
  if (!tail) return false;
  const name = lettersAndDigits(tail);
  if (name.length < 4) return false;
  return r.payee.split(",").some((seller) => {
    const s = lettersAndDigits(seller);
    return s.length >= 4 && (s.startsWith(name) || name.startsWith(s));
  });
}

/**
 * Senders whose peso receipts the card was charged in dollars: Uber BV billed most Chilean rides and
 * orders of 2017–2021 in US$ («UBER BV», «UBER *TRIP»), the receipt still stating pesos. Such a
 * receipt also pairs with a dollar line that names the sender, at the day's rate within
 * `PESO_RECEIPT_IN_DOLLARS_TOLERANCE` — never with an unnamed one, which any purchase of the week
 * could fit.
 */
const PESO_RECEIPT_CHARGED_IN_DOLLARS: Record<string, RegExp> = {
  uber: /UBER/i,
  uber_trip_summary: /UBER/i,
  uber_eats: /UBER/i,
  uber_eats_summary: /UBER/i,
  uber_one: /UBER/i,
};
const PESO_RECEIPT_IN_DOLLARS_TOLERANCE = 0.04;

/**
 * Whether a line carries a charge of the receipt: `exact` — the same pesos, or for a dollar receipt
 * the same dollars to the cent; `at_rate` — a peso receipt of a sender that charged in dollars, on a
 * dollar line naming it (`PESO_RECEIPT_CHARGED_IN_DOLLARS`). A receipt in another currency (abroad)
 * pairs with the dollar line whose original amount is the same to the cent. A dollar receipt never
 * pairs with a peso-only line: within a few percent of the day's rate, any purchase of the week
 * could fit.
 */
function sameAmount(r: StoredPaymentReceipt, amount: number, l: ReceiptCandidateLine): "exact" | "at_rate" | null {
  if (r.currency === "usd") return l.amount_usd != null && Math.abs(l.amount_usd - amount) < 0.005 ? "exact" : null;
  // Abroad: the dollar line's original-currency amount, to the cent (the statement prints it, the
  // receipt states it); never a conversion.
  if (r.currency !== "clp") {
    return l.amount_usd != null && l.amount_orig != null && l.amount_orig_currency == null && Math.abs(l.amount_orig - amount) < 0.005
      ? "exact"
      : null;
  }
  if ((l.principal_clp ?? l.amount_clp) === amount) return "exact";
  // A peso purchase billed on the dollar statement (Airbnb in Chile): its printed peso origin.
  if (l.amount_usd != null && l.amount_orig_currency === "clp" && l.amount_orig === amount) return "exact";
  const sender = PESO_RECEIPT_CHARGED_IN_DOLLARS[r.processor];
  if (!sender || l.amount_usd == null || !(l.amount_usd > 0) || !l.purchase_on || !sender.test(l.merchant ?? "")) return null;
  const fx = fxRowOnOrBefore(l.purchase_on);
  if (!fx) throw new Error(`payment receipt ${r.message_id}: no USD/CLP rate on or before ${l.purchase_on}`);
  return Math.abs(amount / (l.amount_usd * fx.clp_per_usd) - 1) <= PESO_RECEIPT_IN_DOLLARS_TOLERANCE ? "at_rate" : null;
}

/**
 * Documents that summarize an order whose charges another source states one by one: read only for
 * an order none of whose charges paired. Amazon's order confirmation vs its shipment mails (charged
 * when the order ships, which may be weeks after it was placed); Uber's trip summary vs the trip's
 * receipt (the summary comes first, the receipt does not always follow).
 */
const ORDER_SUMMARY_OF: Record<string, { of: string; daysAfter: number }> = {
  amazon_order: { of: "amazon", daysAfter: 30 },
  uber_trip_summary: { of: "uber", daysAfter: 5 },
  uber_eats_summary: { of: "uber_eats", daysAfter: 5 },
};

/**
 * Senders whose later mail about a reservation restates it whole («Your updated booking at …»):
 * only the latest mail of a reservation is paired, or every update would claim the same charge.
 */
const SUPERSEDED_BY_LATER_MAIL = new Set(["booking"]);

function withoutSupersededReceipts(receipts: readonly StoredPaymentReceipt[]): StoredPaymentReceipt[] {
  const latest = new Map<string, StoredPaymentReceipt>();
  for (const r of receipts) {
    if (!SUPERSEDED_BY_LATER_MAIL.has(r.processor) || r.order_ref == null) continue;
    const key = `${r.processor}|${r.order_ref}`;
    const prev = latest.get(key);
    const sent = (x: StoredPaymentReceipt) => x.sent_at_chile ?? x.paid_at_chile;
    if (!prev || sent(r) > sent(prev) || (sent(r) === sent(prev) && r.message_id > prev.message_id)) latest.set(key, r);
  }
  return receipts.filter((r) => !SUPERSEDED_BY_LATER_MAIL.has(r.processor) || r.order_ref == null || latest.get(`${r.processor}|${r.order_ref}`) === r);
}

/** Lodging sources whose unmatched stays may link by the property's name within the stay. */
const STAY_NAME_GUESS_SOURCES = new Set(["booking", "airbnb", "accor"]);

/** Words too common in lodging names to tell two properties apart. */
const LODGING_NAME_STOPWORDS = new Set([
  "HOTEL", "HOTELS", "HOSTEL", "APART", "APARTMENT", "APARTMENTS", "APARTAMENTOS", "STUDIO", "STUDIOS", "SUITE", "SUITES",
  "ROOMS", "HOUSE", "HOME", "CASA", "RESIDENCE", "RESORT", "LODGE", "BOOKING", "CENTRAL", "CITY", "THE", "AND", "PAID",
]);

/** A name's words of four or more letters, accents folded, minus the lodging stopwords, in order. */
function distinctiveWords(name: string): Set<string> {
  const folded = name.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase();
  return new Set(folded.split(/[^A-Z0-9]+/).filter((w) => w.length >= 4 && !LODGING_NAME_STOPWORDS.has(w)));
}

/** A line may be dated the day before the receipt (a mail sent after midnight) up to a few days after. */
const DAYS_BEFORE = 1;
const DAYS_AFTER = 5;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Pairs each receipt with the expense line it paid, or a split payment (`charges`) with one line per
 * charge, all or none. A receipt stating no amount pairs last, with the lines its shop's statement
 * name (`STATEMENT_NAME_FOR_AMOUNTLESS`) or one of its sellers (`SELLER_NAMED_CHARGE`) marks on the
 * nearest day. Otherwise: same pesos (an installment purchase's total line for a charge in cuotas), or
 * for a dollar receipt the same dollars to the cent, dated from the day before the payment to five
 * days after. Receipts go in payment order and each line is taken once, so identical payments pair
 * in order. Among the lines left, the nearest day wins, then a line whose merchant names the
 * processor; a tie that remains is reported and leaves the receipt unpaired.
 */
export function matchPaymentReceipts(
  receipts: readonly StoredPaymentReceipt[],
  lines: readonly ReceiptCandidateLine[]
): {
  byPurchaseKey: Map<string, StoredPaymentReceipt>;
  /** For a split payment's lines: which charge each is. */
  chargeByPurchaseKey: Map<string, { position: number; of: number }>;
  /** Receipts paired (a split payment counts once). */
  receiptsPaired: number;
  unpaired: Record<string, number>;
  ambiguous: string[];
} {
  const candidates = new Map<string, ReceiptCandidateLine>();
  for (const l of lines) {
    if (l.source !== "cc" && l.source !== "checking") continue;
    if (l.line_role === "installment_cuota") continue;
    if (!l.purchase_on || !(l.amount_clp > 0)) continue;
    if (!candidates.has(l.purchase_key)) candidates.set(l.purchase_key, l);
  }
  const taken = new Set<string>();
  const byPurchaseKey = new Map<string, StoredPaymentReceipt>();
  const chargeByPurchaseKey = new Map<string, { position: number; of: number }>();
  let receiptsPaired = 0;
  const unpaired: Record<string, number> = {};
  const ambiguous: string[] = [];
  const sorted = withoutSupersededReceipts(receipts).sort(
    (a, b) => a.paid_at_chile.localeCompare(b.paid_at_chile) || a.message_id.localeCompare(b.message_id)
  );

  /** The line one charge of `r` was taken as, or why there is none. */
  function lineFor(
    r: StoredPaymentReceipt,
    amount: number,
    claimed: ReadonlySet<string>,
    daysAfter = DAYS_AFTER
  ): ReceiptCandidateLine | "none" | string {
    const paidOn = r.paid_at_chile.slice(0, 10);
    const hint = PROCESSOR_MERCHANT_HINT[r.processor];
    // A stay the property charges (the platform did not take the payment) lands at booking or at
    // check-in: up to five days past check-out, and «nearest» counts from either day.
    const stay = r.stay && r.statement_descriptor == null ? r.stay : null;
    const after = stay ? Math.max(daysAfter, dayDiff(stay.check_out, paidOn) + DAYS_AFTER) : daysAfter;
    const fits = [...candidates.values()]
      .filter((l) => !taken.has(l.purchase_key) && !claimed.has(l.purchase_key) && l.purchase_on != null)
      .map((l) => ({ l, d: dayDiff(l.purchase_on!, paidOn) }))
      .filter((c) => c.d >= -DAYS_BEFORE && c.d <= after)
      .map((c) => ({ ...c, match: sameAmount(r, amount, c.l) }))
      .filter((c) => c.match != null)
      .map((c) => ({ ...c, dist: stay ? Math.min(Math.abs(c.d), Math.abs(dayDiff(c.l.purchase_on!, stay.check_in))) : Math.abs(c.d) }))
      // Nearest day first; on a day, an exact amount before one at the day's rate, then a line
      // printing the receipt's own reference («AIRBNB * HM…»), then a line naming the processor.
      .map((c) => ({
        ...c,
        rank:
          c.dist * 8 +
          (c.match === "at_rate" ? 4 : 0) +
          (r.order_ref && (c.l.merchant ?? "").toUpperCase().includes(r.order_ref.toUpperCase()) ? 0 : 2) +
          (hint?.test(c.l.merchant ?? "") ? 0 : 1),
      }))
      .sort((a, b) => a.rank - b.rank);
    if (fits.length === 0) return "none";
    const best = fits.filter((f) => f.rank === fits[0]!.rank);
    // Lines that differ only by key are twins (two identical charges): they pair in order.
    const twins = best.every(
      (f) => f.l.purchase_on === best[0]!.l.purchase_on && f.l.merchant === best[0]!.l.merchant && f.l.source === best[0]!.l.source
    );
    if (best.length > 1 && !twins) {
      return `${r.paid_at_chile} ${r.processor} → ${r.payee} ${amount}: ${best.map((f) => `${f.l.purchase_on} ${f.l.merchant}`).join(" | ")}`;
    }
    return best[0]!.l;
  }

  const pair = (r: StoredPaymentReceipt, picks: readonly ReceiptCandidateLine[]) => {
    receiptsPaired++;
    picks.forEach((pick, i) => {
      taken.add(pick.purchase_key);
      byPurchaseKey.set(pick.purchase_key, r);
      if (picks.length > 1) chargeByPurchaseKey.set(pick.purchase_key, { position: i + 1, of: picks.length });
    });
  };

  const noLine: StoredPaymentReceipt[] = [];
  for (const r of sorted) {
    if (r.amount == null || ORDER_SUMMARY_OF[r.processor]) continue;
    const parts = r.charges && r.charges.length > 0 ? r.charges.map((c) => c.amount) : [r.amount];
    const claimed = new Set<string>();
    const picks: ReceiptCandidateLine[] = [];
    let failure: "none" | string | null = null;
    for (const amount of parts) {
      const pick = lineFor(r, amount, claimed);
      if (typeof pick === "string") {
        failure = pick;
        break;
      }
      claimed.add(pick.purchase_key);
      picks.push(pick);
    }
    if (failure === "none") {
      noLine.push(r);
      continue;
    }
    if (failure != null) {
      ambiguous.push(failure);
      unpaired.ambiguous = (unpaired.ambiguous ?? 0) + 1;
      continue;
    }
    pair(r, picks);
  }

  // Shipments of one order that no line carries one by one: the shop may have charged them together
  // (Amazon charged two shipments of 2025-09-16/17 as one), so they pair with one line of their sum,
  // dated from their latest.
  const byOrder = new Map<string, StoredPaymentReceipt[]>();
  for (const r of noLine) {
    if (r.order_ref == null || (r.charges?.length ?? 0) > 0) continue;
    const key = `${r.processor}|${r.currency}|${r.order_ref}`;
    byOrder.set(key, [...(byOrder.get(key) ?? []), r]);
  }
  const combined = new Set<StoredPaymentReceipt>();
  for (const members of byOrder.values()) {
    if (members.length < 2) continue;
    const latest = members[members.length - 1]!;
    const sum = Math.round(members.reduce((t, m) => t + m.amount!, 0) * 100) / 100;
    const together: StoredPaymentReceipt = {
      ...latest,
      amount: sum,
      concept: members.map((m) => m.concept).filter((c): c is string => c != null).join(" · ") || null,
    };
    const pick = lineFor(together, sum, new Set());
    if (pick === "none") continue;
    if (typeof pick === "string") {
      ambiguous.push(pick);
      continue;
    }
    pair(together, [pick]);
    receiptsPaired += members.length - 1;
    for (const m of members) combined.add(m);
  }
  // A stay no line carries at its stated amount — the property charged a card surcharge, the city
  // tax on top, in another currency, or only its own fees: the lines a property named like it
  // charged during the stay, linked as a guess.
  const stayGuessed = new Set<StoredPaymentReceipt>();
  for (const r of noLine) {
    if (combined.has(r) || !r.stay || !STAY_NAME_GUESS_SOURCES.has(r.processor)) continue;
    // The name's first distinctive word, the city's words left out: «Hotel Ejemplo Lisboa» →
    // EJEMPLO, never LISBOA (a supermarket in town), nor a square a shop shares.
    const cityWords = distinctiveWords(r.stay.city ?? "");
    const key = [...distinctiveWords(r.payee)].find((w) => !cityWords.has(w));
    if (!key) continue;
    const picks = [...candidates.values()]
      .filter(
        (l) =>
          !taken.has(l.purchase_key) &&
          dayDiff(l.purchase_on!, r.stay!.check_in) >= -1 &&
          dayDiff(l.purchase_on!, r.stay!.check_out) <= 1 &&
          distinctiveWords(l.merchant ?? "").has(key)
      )
      .sort((a, b) => a.purchase_on!.localeCompare(b.purchase_on!) || a.purchase_key.localeCompare(b.purchase_key));
    if (picks.length === 0) continue;
    pair({ ...r, guess_basis: "stay dates and property name" }, picks);
    stayGuessed.add(r);
  }
  for (const r of noLine) {
    if (!combined.has(r) && !stayGuessed.has(r)) unpaired.no_line = (unpaired.no_line ?? 0) + 1;
  }

  // An order's confirmation stands in for its shipments only when none of them paired: the card
  // was charged the order total (a gift-card balance paid part of a shipment), or a shipment had no
  // mail. An order a shipment already accounts for is not a missing pairing.
  const pairedOrders = new Set([...byPurchaseKey.values()].filter((r) => r.order_ref != null).map((r) => `${r.processor}|${r.order_ref}`));
  for (const r of sorted) {
    const summary = ORDER_SUMMARY_OF[r.processor];
    if (!summary || r.amount == null) continue;
    if (pairedOrders.has(`${summary.of}|${r.order_ref}`)) continue;
    const pick = lineFor(r, r.amount, new Set(), summary.daysAfter);
    if (pick === "none") {
      unpaired.no_line = (unpaired.no_line ?? 0) + 1;
    } else if (typeof pick === "string") {
      ambiguous.push(pick);
      unpaired.ambiguous = (unpaired.ambiguous ?? 0) + 1;
    } else {
      pair(r, [pick]);
    }
  }

  // Receipts stating no amount, once every amount has claimed its lines: the lines left on the
  // nearest day that carry the shop's own statement name, all of them (an order charged per seller).
  const amountless = sorted
    .filter((r) => r.amount == null)
    .map((r) => {
      const name = STATEMENT_NAME_FOR_AMOUNTLESS[r.processor];
      if (!name) throw new Error(`payment receipt ${r.message_id}: ${r.processor} states no amount and has no statement name to pair by`);
      const paidOn = r.paid_at_chile.slice(0, 10);
      const fits = [...candidates.values()]
        .filter((l) => !taken.has(l.purchase_key) && (name.test(l.merchant ?? "") || chargeNamesSeller(r, l.merchant ?? "")))
        .map((l) => ({ l, d: dayDiff(l.purchase_on!, paidOn) }))
        .filter((c) => c.d >= -DAYS_BEFORE && c.d <= DAYS_AFTER);
      const nearest = Math.min(...fits.map((f) => Math.abs(f.d)));
      return { r, lines: fits.filter((f) => Math.abs(f.d) === nearest).map((f) => f.l) };
    });
  for (const a of amountless) {
    if (a.lines.length === 0) {
      unpaired.no_line = (unpaired.no_line ?? 0) + 1;
      continue;
    }
    const rivals = amountless.filter((b) => b !== a && b.lines.some((l) => a.lines.includes(l)));
    if (rivals.length > 0) {
      ambiguous.push(`${a.r.paid_at_chile} ${a.r.processor} → ${a.r.payee} (no amount): shares ${a.lines.map((l) => `${l.purchase_on} ${l.merchant}`).join(" | ")} with ${rivals.length} other`);
      unpaired.ambiguous = (unpaired.ambiguous ?? 0) + 1;
      continue;
    }
    pair(a.r, [...a.lines].sort((x, y) => x.purchase_key.localeCompare(y.purchase_key)));
  }
  return { byPurchaseKey, chargeByPurchaseKey, receiptsPaired, unpaired, ambiguous };
}

const PROCESSOR_NAMES: Record<string, string> = {
  flow: "Flow",
  pago_facil: "Pago Fácil",
  shopify: "Shopify",
  calvin_klein: "Calvin Klein",
  adidas: "adidas",
  club_domino: "Club Dominó",
  eventbrite: "Eventbrite",
  micoca_cola: "miCoca-Cola",
  dynavap: "DynaVap",
  mercadolibre: "Mercado Libre",
  amazon: "Amazon",
  amazon_order: "Amazon",
  uber: "Uber",
  uber_trip_summary: "Uber",
  uber_eats: "Uber Eats",
  uber_one: "Uber One",
  uber_eats_summary: "Uber Eats",
  latam: "LATAM",
  latam_change: "LATAM",
  despegar: "Despegar",
  booking: "Booking.com",
  airbnb: "Airbnb",
  accor: "Accor",
  stripe: "Stripe",
};

/** Sources that are the shop's own order confirmation rather than a processor's receipt. */
const ORDER_CONFIRMATION_SOURCES = new Set(["shopify", "calvin_klein", "adidas", "club_domino", "eventbrite", "micoca_cola", "dynavap", "mercadolibre", "amazon", "amazon_order", "uber", "uber_trip_summary", "uber_eats", "uber_eats_summary", "uber_one", "latam", "latam_change", "despegar", "booking", "airbnb", "accor"]);

function receiptDto(r: StoredPaymentReceipt, charge: { position: number; of: number } | null = null): PaymentReceiptDto {
  const name = PROCESSOR_NAMES[r.processor];
  if (!name) throw new Error(`payment receipt ${r.message_id}: unknown processor ${r.processor}`);
  return {
    processor: r.processor,
    processor_name: name,
    payee: r.payee,
    payee_rut: r.payee_rut,
    payee_email: r.payee_email,
    concept: r.concept,
    order_ref: r.order_ref,
    paid_at_chile: r.paid_at_chile,
    statement_descriptor: r.statement_descriptor,
    installments: r.installments,
    charge,
    guess: r.guess_basis != null,
    basis: r.guess_basis ?? null,
    trip: r.trip ?? null,
    trip_label: r.trip ? `${shortAddress(r.trip.from)} → ${shortAddress(r.trip.to)}` : null,
    subscription: r.subscription ?? false,
  };
}

/** An address up to its first comma: the street and number, without postal code, comuna and region. */
function shortAddress(address: string): string {
  return address.split(",")[0]!.trim();
}

/** Every line of a paired purchase (its cuotas too) carries the receipt. */
/** The stored receipts paired with the expense lines, as the expenses page shows them. */
/**
 * The stored documents paired with the expense lines, as the expenses page shows them. A shop's
 * order confirmation and the processor's receipt for the same payment both describe one charge,
 * so the two are paired separately; where both land on a line, the order (it names the shop and
 * the items) is the one shown.
 */
export function matchPaymentReceiptsToExpenseLines(lines: readonly (ReceiptCandidateLine & { account_id: number })[]) {
  const all = loadPaymentProcessorReceipts();
  const candidates = withInterestPlanPrincipals(lines);
  const receipts = matchPaymentReceipts(all.filter((r) => !ORDER_CONFIRMATION_SOURCES.has(r.processor)), candidates);
  const orders = matchPaymentReceipts(all.filter((r) => ORDER_CONFIRMATION_SOURCES.has(r.processor)), candidates);
  const unpaired: Record<string, number> = { ...receipts.unpaired };
  for (const [k, n] of Object.entries(orders.unpaired)) unpaired[k] = (unpaired[k] ?? 0) + n;
  return {
    byPurchaseKey: new Map([...receipts.byPurchaseKey, ...orders.byPurchaseKey]),
    chargeByPurchaseKey: new Map([...receipts.chargeByPurchaseKey, ...orders.chargeByPurchaseKey]),
    /** Documents paired (a charge with both a receipt and an order counts both; a split payment once). */
    paired: receipts.receiptsPaired + orders.receiptsPaired,
    unpaired,
    ambiguous: [...receipts.ambiguous, ...orders.ambiguous],
  };
}

/**
 * Every line whose purchase a document explains carries it: an App Store charge its app
 * (`merchantExpenseNotes.ts`), any other charge its payment processor's receipt.
 */
export function withPaymentReceipts<L extends ReceiptCandidateLine & { account_id: number }>(
  lines: L[]
): (L & { payment_receipt?: PaymentReceiptDto })[] {
  const appStore = new Map<string, PaymentReceiptDto>();
  for (const link of deriveMerchantChargeLinks().links) {
    appStore.set(`${link.account_id}|${link.key}`, {
      processor: "app_store",
      processor_name: "App Store",
      payee: link.name,
      payee_rut: null,
      payee_email: null,
      concept: link.concept,
      order_ref: null,
      paid_at_chile: link.date,
      statement_descriptor: null,
      installments: null,
      charge: null,
      guess: link.guess,
      basis: link.basis,
      trip: null,
      trip_label: null,
      subscription: link.subscription,
    });
  }
  const named = lines.map((l) => {
    const r = l.source === "cc" ? appStore.get(`${l.account_id}|${l.purchase_key}`) : undefined;
    return r ? { ...l, payment_receipt: r } : l;
  });
  const { byPurchaseKey, chargeByPurchaseKey } = matchPaymentReceiptsToExpenseLines(named.filter((l) => !("payment_receipt" in l)));
  return named.map((l) => {
    if ("payment_receipt" in l) return l;
    const r = byPurchaseKey.get(l.purchase_key);
    return r ? { ...l, payment_receipt: receiptDto(r, chargeByPurchaseKey.get(l.purchase_key) ?? null) } : l;
  });
}

/** Each interest plan's total line, with the principal its statements print (`ccInstallmentInterest.ts`). */
function withInterestPlanPrincipals<L extends ReceiptCandidateLine & { account_id: number }>(lines: readonly L[]): L[] {
  const principalByAccount = new Map<number, Map<string, number>>();
  const principalFor = (accountId: number, iso: string, total: number): number | null => {
    let byPlan = principalByAccount.get(accountId);
    if (!byPlan) {
      byPlan = new Map();
      for (const p of ccInstallmentInterestForAccount(accountId)) {
        const key = `${p.iso}|${p.total_clp}`;
        const seen = byPlan.get(key);
        if (seen != null && seen !== p.principal_clp) throw new Error(`two interest plans on ${p.iso} for ${p.total_clp} print different principals`);
        byPlan.set(key, p.principal_clp);
      }
      principalByAccount.set(accountId, byPlan);
    }
    return byPlan.get(`${iso}|${total}`) ?? null;
  };
  return lines.map((l) =>
    l.source === "cc" && l.line_role === "installment_purchase_total" && l.purchase_on
      ? { ...l, principal_clp: principalFor(l.account_id, l.purchase_on, l.amount_clp) }
      : l
  );
}
