/**
 * Payment processors' receipts (`payment.processor_receipts`): who a charge that names only the
 * processor («PAGOS.FLOW.CL (WEB)», «PAGO FACIL») actually paid, and for what.
 *
 * The receipts are stored as mailed; which expense line each describes is derived every time the
 * expense lines are built, because a card line's id changes on every statement re-import. Pairing
 * keys on the line's purchase key and the receipt's pesos and payment day; see `matchPaymentReceipts`.
 */
import { createHash } from "node:crypto";
import type { PaymentProcessorReceiptsPayload, ProcessorReceipt } from "nw-tracker-contracts";
import { ccInstallmentInterestForAccount } from "./ccInstallmentInterest.js";
import { db } from "./db.js";
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
  };
}

function hash(row: ReceiptRow): string {
  return createHash("sha256")
    .update(JSON.stringify(COLUMNS.map((c) => row[c])))
    .digest("hex");
}

/** Stores the receipts; a receipt already stored must state the same. */
export function storePaymentProcessorReceipts(payload: PaymentProcessorReceiptsPayload): { received: number; new_receipts: number } {
  const existing = db.prepare(`SELECT ${COLUMNS.join(", ")} FROM payment_processor_receipts WHERE message_id = ?`);
  const insert = db.prepare(
    `INSERT INTO payment_processor_receipts (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map((c) => `@${c}`).join(", ")})`
  );
  return db.transaction(() => {
    let added = 0;
    for (const r of payload.receipts) {
      const row = receiptRow(r);
      const old = existing.get(r.message_id) as ReceiptRow | undefined;
      if (old) {
        if (hash(old) !== hash(row)) throw new Error(`payment receipt ${r.message_id} was already stored with other content`);
        continue;
      }
      insert.run(row);
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
  /** Inferred (a subscription's billing cycle, a monthly run), not read off a receipt. */
  guess: boolean;
  /** What the link rests on («receipt 2026-05-02», «subscription renewal notice», «monthly run»). */
  basis: string | null;
};

export type StoredPaymentReceipt = Omit<PaymentReceiptDto, "processor_name" | "guess" | "basis"> & {
  message_id: string;
  amount: number;
  currency: "clp" | "usd";
};

export function loadPaymentProcessorReceipts(): StoredPaymentReceipt[] {
  const rows = db
    .prepare(`SELECT ${COLUMNS.join(", ")} FROM payment_processor_receipts ORDER BY paid_at_chile, message_id`)
    .all() as ReceiptRow[];
  return rows.map((r) => ({
    message_id: String(r.message_id),
    processor: String(r.processor),
    payee: String(r.payee_name),
    payee_rut: (r.payee_rut as string | null) ?? null,
    payee_email: (r.payee_email as string | null) ?? null,
    concept: (r.concept as string | null) ?? null,
    order_ref: (r.order_ref as string | null) ?? null,
    paid_at_chile: String(r.paid_at_chile),
    statement_descriptor: (r.statement_descriptor as string | null) ?? null,
    installments: (r.installments as number | null) ?? null,
    amount: Number(r.amount),
    currency: receiptCurrency(r),
  }));
}

function receiptCurrency(r: ReceiptRow): "clp" | "usd" {
  if (r.currency !== "clp" && r.currency !== "usd") throw new Error(`payment receipt ${r.message_id}: currency ${r.currency}`);
  return r.currency;
}

/** The expense-line fields the pairing reads. */
export type ReceiptCandidateLine = {
  source: string;
  purchase_key: string;
  amount_clp: number;
  /** A dollar charge's dollars (the card's dollar side). */
  amount_usd?: number | null;
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
};

/**
 * Whether a line carries the receipt's amount: the same pesos, or for a dollar receipt the same
 * dollars to the cent. A dollar receipt never pairs with a peso-only line: within a few percent of
 * the day's rate, any purchase of the week could fit.
 */
function sameAmount(r: StoredPaymentReceipt, l: ReceiptCandidateLine): boolean {
  if (r.currency === "clp") return (l.principal_clp ?? l.amount_clp) === r.amount;
  return l.amount_usd != null && Math.abs(l.amount_usd - r.amount) < 0.005;
}

/** A line may be dated the day before the receipt (a mail sent after midnight) up to a few days after. */
const DAYS_BEFORE = 1;
const DAYS_AFTER = 5;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/**
 * Pairs each receipt with the one expense line it paid: same pesos (an installment purchase's total
 * line for a split payment), or for a dollar receipt the same dollars to the cent, dated from the day before the payment to five days after. Receipts go
 * in payment order and each line is taken once, so identical payments pair in order. Among the
 * lines left, the nearest day wins, then a line whose merchant names the processor; a tie that
 * remains is reported and left unpaired.
 */
export function matchPaymentReceipts(
  receipts: readonly StoredPaymentReceipt[],
  lines: readonly ReceiptCandidateLine[]
): { byPurchaseKey: Map<string, StoredPaymentReceipt>; unpaired: Record<string, number>; ambiguous: string[] } {
  const candidates = new Map<string, ReceiptCandidateLine>();
  for (const l of lines) {
    if (l.source !== "cc" && l.source !== "checking") continue;
    if (l.line_role === "installment_cuota") continue;
    if (!l.purchase_on || !(l.amount_clp > 0)) continue;
    if (!candidates.has(l.purchase_key)) candidates.set(l.purchase_key, l);
  }
  const taken = new Set<string>();
  const byPurchaseKey = new Map<string, StoredPaymentReceipt>();
  const unpaired: Record<string, number> = {};
  const ambiguous: string[] = [];
  const sorted = [...receipts].sort((a, b) => a.paid_at_chile.localeCompare(b.paid_at_chile) || a.message_id.localeCompare(b.message_id));
  for (const r of sorted) {
    const paidOn = r.paid_at_chile.slice(0, 10);
    const hint = PROCESSOR_MERCHANT_HINT[r.processor];
    const fits = [...candidates.values()]
      .filter((l) => !taken.has(l.purchase_key) && sameAmount(r, l))
      .map((l) => ({ l, d: dayDiff(l.purchase_on!, paidOn) }))
      .filter((c) => c.d >= -DAYS_BEFORE && c.d <= DAYS_AFTER)
      .map((c) => ({ ...c, rank: Math.abs(c.d) * 2 + (hint?.test(c.l.merchant ?? "") ? 0 : 1) }))
      .sort((a, b) => a.rank - b.rank);
    if (fits.length === 0) {
      unpaired.no_line = (unpaired.no_line ?? 0) + 1;
      continue;
    }
    const best = fits.filter((f) => f.rank === fits[0]!.rank);
    // Lines that differ only by key are twins (two identical charges): they pair in order.
    const twins = best.every(
      (f) => f.l.purchase_on === best[0]!.l.purchase_on && f.l.merchant === best[0]!.l.merchant && f.l.source === best[0]!.l.source
    );
    if (best.length > 1 && !twins) {
      ambiguous.push(`${r.paid_at_chile} ${r.processor} → ${r.payee} ${r.amount}: ${best.map((f) => `${f.l.purchase_on} ${f.l.merchant}`).join(" | ")}`);
      unpaired.ambiguous = (unpaired.ambiguous ?? 0) + 1;
      continue;
    }
    const pick = best[0]!.l;
    taken.add(pick.purchase_key);
    byPurchaseKey.set(pick.purchase_key, r);
  }
  return { byPurchaseKey, unpaired, ambiguous };
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
};

/** Sources that are the shop's own order confirmation rather than a processor's receipt. */
const ORDER_CONFIRMATION_SOURCES = new Set(["shopify", "calvin_klein", "adidas", "club_domino", "eventbrite", "micoca_cola", "dynavap"]);

function receiptDto(r: StoredPaymentReceipt): PaymentReceiptDto {
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
    guess: false,
    basis: null,
  };
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
    /** Documents paired (a charge with both a receipt and an order counts both). */
    paired: receipts.byPurchaseKey.size + orders.byPurchaseKey.size,
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
      guess: link.guess,
      basis: link.basis,
    });
  }
  const named = lines.map((l) => {
    const r = l.source === "cc" ? appStore.get(`${l.account_id}|${l.purchase_key}`) : undefined;
    return r ? { ...l, payment_receipt: r } : l;
  });
  const { byPurchaseKey } = matchPaymentReceiptsToExpenseLines(named.filter((l) => !("payment_receipt" in l)));
  return named.map((l) => {
    if ("payment_receipt" in l) return l;
    const r = byPurchaseKey.get(l.purchase_key);
    return r ? { ...l, payment_receipt: receiptDto(r) } : l;
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
