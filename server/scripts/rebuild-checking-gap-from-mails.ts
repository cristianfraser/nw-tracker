/**
 * One-off: rebuild a cuenta corriente gap (lost cartolas) and the card statements of the same months
 * from Santander's transactional mails.
 *
 * Inputs: the mails staged by `npm run fetch:santander-mail-archive -w nw-tracker-ingest` and a plan
 * file in `cfraser/` (account ids and numbers, the gap, the bank's closed days, estimated card closes,
 * the real-estate bills to re-point) — personal values never live in this script.
 *
 * What a mail is, and what it becomes:
 *  - «Aviso de transferencia entre productos» between corriente and vista: the vista cartola already
 *    lists it; a corriente leg is added and the pair becomes one transfer dated by the mail (the
 *    execution), each account keeping its posting day.
 *  - «Comprobante pago Tarjeta de crédito» / «Compra de divisas» from the corriente: a corriente debit
 *    paired with the card's payment line (`convertCcPaymentMirrors`), dated by the mail.
 *  - Transfers to third parties, scheduled transfers (rent), CMR Falabella payments, and transfers
 *    received: single-leg corriente rows dated by the mail, with the posting day recorded. Rent and
 *    gastos comunes become the real-estate bills' purchases (bills re-pointed per the plan, the
 *    excel-gap rows they replace deleted); everything else is spending, left uncategorized (the excel-gap
 *    rows of those months are recomputed against it afterwards), and credits are income. The estimated
 *    card charges below stay `no_cuenta`: they only
 *    stand in for spending the excel-gap rows already carry by category.
 *  - The posting day is the bank's: a mail after 14:00, or on a closed day, posts the next bank day.
 *    It is checked against every vista cartola row the transfers pair with.
 *  - What the mails do not explain (transfers received from other banks are never mailed) is one
 *    residual row, replacing the plan's lump movement, so the corriente lands on the next cartola.
 *
 * Card: one CLP and one USD statement per lost close. CLP: the payments as dated MONTO CANCELADO
 * lines, the mailed facturado (months without a mail share the unexplained charges evenly), and the
 * charges as weekly lines (`no_cuenta`) so that facturado = previous − payments + charges. USD: the
 * ABONO DE DIVISAS lines in their cycle and one estimated charge — the balance the next real
 * statement prints as saldo anterior, less the last real one's deuda, plus the abonos.
 *
 * Without --apply the whole transaction is rolled back after printing, so the report IS the plan.
 *
 *   npx tsx scripts/rebuild-checking-gap-from-mails.ts --plan=<cfraser json> [--apply]
 */
import fs from "node:fs";
import path from "node:path";

import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { parseChileanNumber } from "../src/chileanNumber.js";
import { recordBankPosting } from "../src/movementBankPostings.js";
import { convertMirrorPairs } from "../src/movementMirrorConvert.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { upsertCreditCardValuationsFromLedger } from "../src/ccCreditCardValuations.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { checkingMovementBalanceClpAt, clearCheckingBalanceCache } from "../src/checkingCartolaBalances.js";
import { clearAggregationCache } from "../src/aggregationCache.js";

const apply = process.argv.includes("--apply");
const planArg = process.argv.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planArg) throw new Error("--plan=<path to the cfraser plan json> is required");

type Plan = {
  archive: string;
  gap: { from: string; to: string };
  accounts: {
    corriente: { id: number; number: string };
    vista: { id: number; number: string };
    card: { id: number; last4: string };
  };
  opening_clp: number;
  closing_clp: number;
  lump_movement_id: number;
  residual_on: string;
  bank_closed_days: string[];
  card_statements: {
    previous: { close: string; usd_deuda: number };
    next: { close: string; usd_saldo_anterior: number };
    closes: string[];
    pay_by_days: number;
    usd_charge_on: string;
    header_leg_fix: { leg_id: number; paid_on: string };
  };
  bills: {
    entry_id: number | null;
    kind: string;
    bill_month: string;
    paid: { on: string; amount: number };
  }[];
  place_expense_account_id: number;
  excel_gap_entries_replaced: number[];
};
type Mail = { message_id: string; sent_at_chile: string; from: string; subject: string; text: string };

const plan = JSON.parse(fs.readFileSync(path.resolve(planArg), "utf8")) as Plan;
const mails = JSON.parse(
  fs.readFileSync(path.join(resolveCfraserCsvDir(), plan.archive), "utf8")
) as Mail[];
const CORRIENTE = plan.accounts.corriente.id;
const VISTA = plan.accounts.vista.id;
const CARD = plan.accounts.card.id;
const CATEGORY = Object.fromEntries(
  (db.prepare(`SELECT id, slug FROM cc_expense_categories`).all() as { id: number; slug: string }[]).map(
    (c) => [c.slug, c.id]
  )
) as Record<string, number>;

class Rollback extends Error {}

// ── Bank days ────────────────────────────────────────────────────────────────

const closedDays = new Set(plan.bank_closed_days);
function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function isBankDay(ymd: string): boolean {
  const wd = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6 && !closedDays.has(ymd);
}
/** The bank day a movement made at `sentAt` (Chile clock) is posted on: 14:00 cutoff, closed days skip. */
function postingDay(sentAt: string): string {
  let day = sentAt.slice(0, 10);
  if (sentAt.slice(11, 16) >= "14:00" || !isBankDay(day)) {
    day = addDays(day, 1);
    while (!isBankDay(day)) day = addDays(day, 1);
  }
  return day;
}
const inGap = (posted: string) => posted >= plan.gap.from && posted <= plan.gap.to;

// ── Mail decoding ────────────────────────────────────────────────────────────

const pesos = (s: string | undefined, what: string, m: Mail): number => {
  if (!s) throw new Error(`${m.sent_at_chile} «${m.subject}»: no ${what}`);
  return parseChileanNumber(s.replace(/\.-?$/, "").replace(/\.$/, ""));
};
const digits = (s: string) => s.replace(/\D/g, "");
const accountByNumber = new Map([
  [digits(plan.accounts.corriente.number), CORRIENTE],
  [digits(plan.accounts.vista.number), VISTA],
]);
function ownAccount(num: string | undefined): number | null {
  if (!num) return null;
  const d = digits(num);
  for (const [k, id] of accountByNumber) if (d.endsWith(k.replace(/^0+/, ""))) return id;
  return null;
}

type Event =
  | { kind: "between"; mail: Mail; from: number; to: number; amount: number }
  | { kind: "card_payment"; mail: Mail; from: number; amount: number; last4: string }
  | { kind: "divisas"; mail: Mail; from: number; pesos: number; usd: number; last4: string }
  | { kind: "transfer_out"; mail: Mail; from: number; amount: number; payee: string; bank: string }
  | { kind: "transfer_in"; mail: Mail; to: number; amount: number; sender: string }
  | { kind: "cmr"; mail: Mail; from: number; amount: number }
  | { kind: "facturado"; mail: Mail; last4: string; amount: number }
  | { kind: "ignored"; mail: Mail; why: string };

/** The holder's own name as the bank prints it on outgoing transfers (to drop own-transfer echoes). */
const holderNames = new Set<string>();

function decode(m: Mail): Event {
  const t = m.text;
  if (/monto total facturado/i.test(t)) {
    const r = t.match(/terminada en (\d{4}) es de:\s*\$\s*([\d.]+)/);
    if (!r) throw new Error(`${m.sent_at_chile}: facturado mail without card or amount`);
    return { kind: "facturado", mail: m, last4: r[1]!, amount: pesos(r[2], "facturado", m) };
  }
  if (/^Aviso de Transferencias a Fecha/i.test(m.subject))
    return { kind: "ignored", mail: m, why: "scheduling notice (the transfers it schedules are mailed when they run)" };
  if (/^Aviso de transferencia entre productos/i.test(m.subject)) {
    const accts = [...t.matchAll(/Cuenta N\s*:\s*([\d-]+)/g)].map((x) => ownAccount(x[1]));
    const [from, to] = accts;
    if (from == null || to == null || accts.length !== 2) throw new Error(`${m.sent_at_chile}: between-products mail without two own accounts`);
    return { kind: "between", mail: m, from, to, amount: pesos(t.match(/Monto de Transferencia:\s*\$?\s*([\d.]+)/)?.[1], "amount", m) };
  }
  if (/^Compra de divisas/i.test(m.subject)) {
    const from = ownAccount(t.match(/ORIGEN.*?Cuenta Nro\.:\s*([\d-]+)/)?.[1]);
    if (from == null) throw new Error(`${m.sent_at_chile}: divisas mail without an own origin account`);
    return {
      kind: "divisas",
      mail: m,
      from,
      pesos: pesos(t.match(/Equivalencia en pesos:\s*\$\s*([\d.]+)/)?.[1], "pesos", m),
      usd: Number(t.match(/Cantidad de Dolares:\s*USD\s*([\d.,]+)/)?.[1]?.replace(/\./g, "").replace(",", ".")),
      last4: t.match(/XXXX-(\d{4})/)?.[1] ?? "",
    };
  }
  if (/^Comprobante pago Tarjeta/i.test(m.subject)) {
    const from = ownAccount(t.match(/ORIGEN.*?Cuenta:\s*([\d-]+)/)?.[1]);
    if (from == null) throw new Error(`${m.sent_at_chile}: card payment mail without an own origin account`);
    return {
      kind: "card_payment",
      mail: m,
      from,
      amount: pesos(t.match(/Monto del pago:\s*\$\s*([\d.]+)/)?.[1], "amount", m),
      last4: t.match(/XXXX-(\d{4})/)?.[1] ?? "",
    };
  }
  if (/^Comprobante de Pago/i.test(m.subject)) {
    if (!/CMR\s*falabella/i.test(t)) throw new Error(`${m.sent_at_chile}: bill payment to an unknown service`);
    const amount = pesos(t.match(/(?:Monto Pagado\s*:\s*\$|por un total de:\s*\$)\s*([\d.]+)/)?.[1], "amount", m);
    const num = t.match(/Cuenta (?:N°|Nro\.)\s*:\s*([\d-]+)/)?.[1];
    const from =
      ownAccount(num) ??
      (/CUENTA CORRIENTE/i.test(t) ? CORRIENTE : /CUENTA VISTA/i.test(t) ? VISTA : null);
    if (from == null) throw new Error(`${m.sent_at_chile}: CMR payment from an unknown account`);
    return { kind: "cmr", mail: m, from, amount };
  }
  if (/instruido una transferencia/i.test(t)) {
    const sender = t.match(/cliente (.+?) ha instruido/)?.[1]?.trim() ?? "";
    const to = ownAccount(t.match(/destino Nro\.:\s*(?:Banco [A-Za-z ]+?\s)?([\d-]+)/i)?.[1]);
    const amount = pesos(t.match(/Monto de la Operacion:\s*(?:[\d.]+-[\dkK]\s+)?\$?\s*([\d.]+)/)?.[1], "amount", m);
    if (to == null) return { kind: "ignored", mail: m, why: `transfer received at another bank (from ${sender})` };
    return { kind: "transfer_in", mail: m, to, amount, sender };
  }
  if (/^(Transferencia|Aviso de Transferencia)/i.test(m.subject)) {
    const origin = t.match(/ORIGEN.*?(\d-\d{3}-\d{2}-\d{5}-\d)/)?.[1];
    const from = ownAccount(origin);
    if (from == null) throw new Error(`${m.sent_at_chile}: outgoing transfer from an unknown account`);
    const holder = t.match(/ORIGEN.*?Nombre\s*:\s*([A-Z][A-Z ]+?)\s+(?:Comentario|DESTINO)/)?.[1]?.trim();
    if (holder) holderNames.add(holder);
    const dest = t.slice(t.indexOf("DESTINO"));
    const payee =
      dest.match(/Nombre\s*:\s*(?:Mail:\s*)?([A-ZÑ][A-ZÑ .]+?)(?=\s+(?:Mail|Recuerda|Si tienes|[a-z]))/)?.[1]?.trim() ?? "?";
    const bank = dest.match(/Banco\s*:\s*(?:Tipo de cuenta:\s*)?([A-Za-zé /-]+?)\s+(?:Tipo|Cuenta|Banco Santander|Cuenta N)/)?.[1]?.trim() ?? "";
    return {
      kind: "transfer_out",
      mail: m,
      from,
      amount: pesos(t.match(/Monto de transferencia:\s*\$?\s*([\d.]+)/i)?.[1], "amount", m),
      payee,
      bank,
    };
  }
  return { kind: "ignored", mail: m, why: "not a movement" };
}

const events = mails.map(decode);
// An incoming-transfer mail whose sender is the holder is the echo of an own outgoing transfer.
for (let i = 0; i < events.length; i++) {
  const e = events[i]!;
  if (e.kind === "transfer_in" && holderNames.has(e.sender))
    events[i] = { kind: "ignored", mail: e.mail, why: "own outgoing transfer echoed" };
}

// ── The run ──────────────────────────────────────────────────────────────────

const fmt = (n: number) => Math.round(n).toLocaleString("es-CL");
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const sentDay = (m: Mail) => m.sent_at_chile.slice(0, 10);
const mailRef = (m: Mail) => `correo Santander ${m.sent_at_chile}`;
/** A corriente row's note: the document prefix `listCheckingMovements` reads, the mail's time, the description. */
const mailNote = (m: Mail, description: string) => `import:santander-mail|${m.sent_at_chile}|${description}`;

const insSingle = db.prepare(
  `INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`
);
const setCategory = db.prepare(
  `INSERT INTO cc_expense_unique_purchases (account_id, purchase_key, category_id) VALUES (?, ?, ?)
   ON CONFLICT(account_id, purchase_key) DO UPDATE SET category_id = excluded.category_id`
);
function single(accountId: number, amount: number, m: Mail, note: string, postedOn: string): number {
  const id = Number(insSingle.run(accountId, amount, sentDay(m), mailNote(m, note)).lastInsertRowid);
  if (postedOn !== sentDay(m)) recordBankPosting(id, accountId, postedOn);
  return id;
}

const tx = db.transaction(() => {
  const report: string[] = [];
  const say = (s: string) => report.push(s);
  const corrienteFlows: { posted: string; amount: number; what: string }[] = [];

  // 1. Corriente ↔ vista transfers, paired with the vista cartola rows.
  const vistaRows = db
    .prepare(
      `SELECT id, occurred_on, amount, note FROM movements
       WHERE account_id = ? AND from_account_id IS NULL AND to_account_id IS NULL
         AND occurred_on BETWEEN ? AND ? AND note LIKE '%Traspaso Internet%Cta%'`
    )
    .all(VISTA, plan.gap.from, plan.gap.to) as { id: number; occurred_on: string; amount: number; note: string }[];
  const usedVista = new Set<number>();
  const betweens = events.filter((e): e is Extract<Event, { kind: "between" }> => e.kind === "between");
  const pairs: { out_movement_id: number; in_movement_id: number; mail: Mail; posted: string }[] = [];
  for (const e of betweens) {
    const posted = postingDay(e.mail.sent_at_chile);
    if (!inGap(posted)) continue;
    const vistaSigned = e.from === VISTA ? -e.amount : e.amount;
    const match = vistaRows.filter((r) => !usedVista.has(r.id) && r.amount === vistaSigned && r.occurred_on === posted);
    if (match.length !== 1)
      throw new Error(`${e.mail.sent_at_chile} ${fmt(e.amount)}: ${match.length} vista cartola rows posted ${posted} (posting rule or pairing broken)`);
    usedVista.add(match[0]!.id);
    const corrienteId = Number(
      insSingle.run(
        CORRIENTE,
        -vistaSigned,
        posted,
        mailNote(e.mail, e.from === VISTA ? "Traspaso Internet desde Cta. Vista" : "Traspaso Internet a Cta. Vista")
      ).lastInsertRowid
    );
    corrienteFlows.push({ posted, amount: -vistaSigned, what: "vista" });
    pairs.push(
      e.from === VISTA
        ? { out_movement_id: match[0]!.id, in_movement_id: corrienteId, mail: e.mail, posted }
        : { out_movement_id: corrienteId, in_movement_id: match[0]!.id, mail: e.mail, posted }
    );
  }
  const leftover = vistaRows.filter((r) => !usedVista.has(r.id));
  if (leftover.length > 0)
    throw new Error(`vista traspasos with no mail: ${leftover.map((r) => `${r.id} ${r.occurred_on} ${fmt(r.amount)}`).join("; ")}`);
  const { converted } = convertMirrorPairs(pairs.map(({ out_movement_id, in_movement_id }) => ({ out_movement_id, in_movement_id })));
  const setDate = db.prepare(`UPDATE movements SET occurred_on = ? WHERE id = ?`);
  for (const [i, c] of converted.entries()) setDate.run(sentDay(pairs[i]!.mail), c.transfer_movement_id);
  say(`vista↔corriente: ${converted.length} transfers (vista cartola rows paired: ${usedVista.size}), posting rule held on every one`);

  // 2. Single-leg corriente rows.
  const billPayments = new Map<string, number>(); // `${on}|${amount}` → movement id
  const cardDebits: { kind: "clp" | "usd"; mail: Mail; amount: number; usd?: number }[] = [];
  const counts: Record<string, { n: number; sum: number }> = {};
  const count = (k: string, amt: number) => {
    counts[k] = counts[k] ?? { n: 0, sum: 0 };
    counts[k]!.n++;
    counts[k]!.sum += amt;
  };
  for (const e of events) {
    if (e.kind === "ignored" || e.kind === "between" || e.kind === "facturado") continue;
    const posted = postingDay(e.mail.sent_at_chile);
    const account = e.kind === "transfer_in" ? e.to : e.from;
    if (account !== CORRIENTE || !inGap(posted)) continue;
    if (e.kind === "card_payment") {
      if (e.last4 !== plan.accounts.card.last4) throw new Error(`${e.mail.sent_at_chile}: payment to card ${e.last4}`);
      insSingle.run(CORRIENTE, -e.amount, posted, mailNote(e.mail, "Traspaso Internet a T. Crédito"));
      cardDebits.push({ kind: "clp", mail: e.mail, amount: e.amount });
      corrienteFlows.push({ posted, amount: -e.amount, what: "card" });
      count("card payments", e.amount);
    } else if (e.kind === "divisas") {
      insSingle.run(CORRIENTE, -e.pesos, posted, mailNote(e.mail, `Egreso por Compra de Divisas US$${e.usd.toFixed(2)}`));
      cardDebits.push({ kind: "usd", mail: e.mail, amount: e.pesos, usd: e.usd });
      corrienteFlows.push({ posted, amount: -e.pesos, what: "divisas" });
      count("divisas", e.pesos);
    } else if (e.kind === "cmr") {
      single(CORRIENTE, -e.amount, e.mail, "PAGO EN LINEA CMR FALABELLA", posted);
      corrienteFlows.push({ posted, amount: -e.amount, what: "cmr" });
      count("CMR Falabella (gastos, uncategorized)", e.amount);
    } else if (e.kind === "transfer_out") {
      const id = single(CORRIENTE, -e.amount, e.mail, `Transf a ${e.payee}${e.bank ? ` (${e.bank})` : ""}`, posted);
      const bill = plan.bills.find((b) => b.paid.on === sentDay(e.mail) && b.paid.amount === e.amount);
      if (bill) {
        billPayments.set(`${bill.paid.on}|${bill.paid.amount}`, id);
        setCategory.run(CORRIENTE, `checking-mv:${id}`, CATEGORY.bills);
        count(`bills: ${bill.kind}`, e.amount);
      } else {
        count("transfers to people (gastos, uncategorized)", e.amount);
      }
      corrienteFlows.push({ posted, amount: -e.amount, what: bill ? bill.kind : "people" });
    } else if (e.kind === "transfer_in") {
      single(CORRIENTE, e.amount, e.mail, `Transf. de ${e.sender}`, posted);
      corrienteFlows.push({ posted, amount: e.amount, what: "received" });
      count("received (income, unclassified)", e.amount);
    }
  }
  for (const [k, v] of Object.entries(counts)) say(`  corriente ${k}: ${v.n} rows, ${fmt(v.sum)}`);
  const missingBills = plan.bills.filter((b) => !billPayments.has(`${b.paid.on}|${b.paid.amount}`));
  if (missingBills.length > 0) throw new Error(`bill payments with no mail: ${JSON.stringify(missingBills)}`);

  // 3. Residual: the corriente must land on the next cartola's opening.
  const lump = db.prepare(`SELECT amount, occurred_on FROM movements WHERE id = ? AND account_id = ?`).get(plan.lump_movement_id, CORRIENTE) as
    | { amount: number; occurred_on: string }
    | undefined;
  if (!lump) throw new Error(`lump movement ${plan.lump_movement_id} not on the corriente`);
  const net = corrienteFlows.reduce((s, f) => s + f.amount, 0);
  const residual = plan.closing_clp - plan.opening_clp - net;
  db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE purchase_key = ?`).run(`checking-mv:${plan.lump_movement_id}`);
  db.prepare(`DELETE FROM checking_income_movement_overrides WHERE movement_id = ?`).run(plan.lump_movement_id);
  db.prepare(`DELETE FROM movements WHERE id = ?`).run(plan.lump_movement_id);
  insSingle.run(
      CORRIENTE,
      residual,
      plan.residual_on,
      `import:santander-mail|residual|Ajuste: movimientos ${plan.gap.from} a ${plan.gap.to} sin correo (cartolas perdidas; saldo ${fmt(plan.opening_clp)} → ${fmt(plan.closing_clp)}, reconstruido de correos)`
  );
  say(
    `corriente: opening ${fmt(plan.opening_clp)} + mailed ${fmt(net)} = ${fmt(plan.opening_clp + net)}; closing ${fmt(plan.closing_clp)} → residual ${fmt(residual)} (replaces lump ${plan.lump_movement_id}: ${fmt(lump.amount)})`
  );
  const byMonth = new Map<string, number>();
  for (const f of corrienteFlows) byMonth.set(f.posted.slice(0, 7), (byMonth.get(f.posted.slice(0, 7)) ?? 0) + f.amount);
  let run = plan.opening_clp;
  const lows: string[] = [];
  for (const f of [...corrienteFlows].sort((a, b) => a.posted.localeCompare(b.posted))) {
    run += f.amount;
    if (run < 0) lows.push(`${f.posted} ${fmt(run)}`);
  }
  say(`  net by posting month: ${[...byMonth].map(([m, v]) => `${m} ${fmt(v)}`).join(", ")}`);
  say(`  running balance on posting days below 0 (before the residual): ${lows.length ? lows.join(", ") : "never"}`);

  // 4. Card statements.
  const cs = plan.card_statements;
  const fixLeg = db.prepare(`UPDATE cc_header_payment_legs SET paid_on = ?, source = 'bank_debit' WHERE id = ? AND account_id = ?`);
  if (fixLeg.run(cs.header_leg_fix.paid_on, cs.header_leg_fix.leg_id, CARD).changes !== 1)
    throw new Error(`header leg ${cs.header_leg_fix.leg_id} not on the card`);
  const facturados = events.filter((e): e is Extract<Event, { kind: "facturado" }> => e.kind === "facturado" && e.last4 === plan.accounts.card.last4);
  const closes = [cs.previous.close, ...cs.closes];
  /** The facturado a mail states belongs to the latest close before the mail. */
  const facturadoByClose = new Map<string, number>();
  for (const f of facturados) {
    const close = [...closes].reverse().find((c) => c < sentDay(f.mail));
    if (close) facturadoByClose.set(close, f.amount);
  }
  if (!facturadoByClose.has(cs.previous.close)) throw new Error("no facturado mail for the last real statement");
  const cycleOf = (iso: string) => cs.closes.find((c, i) => iso >= (i === 0 ? cs.previous.close : cs.closes[i - 1]!) && iso < c);
  // Every card payment and divisas of the lost cycles, from any account.
  const paidIn = new Map<string, number>();
  const abonos = new Map<string, { on: string; usd: number }[]>();
  for (const e of events) {
    if ((e.kind === "card_payment" || e.kind === "divisas") && e.last4 === plan.accounts.card.last4) {
      const c = cycleOf(sentDay(e.mail));
      if (!c) continue;
      if (e.kind === "card_payment") paidIn.set(c, (paidIn.get(c) ?? 0) + e.amount);
      else abonos.set(c, [...(abonos.get(c) ?? []), { on: sentDay(e.mail), usd: e.usd }]);
    }
  }
  // Facturado per close: mailed, else the unexplained charges of the unmailed run shared evenly.
  const fact = new Map<string, number>([[cs.previous.close, facturadoByClose.get(cs.previous.close)!]]);
  const charges = new Map<string, number>();
  for (let i = 0; i < cs.closes.length; ) {
    let j = i;
    while (j < cs.closes.length && !facturadoByClose.has(cs.closes[j]!)) j++;
    if (j === cs.closes.length) throw new Error(`no facturado mail closes the run from ${cs.closes[i]}`);
    const prev = fact.get(closes[i]!)!;
    const run = cs.closes.slice(i, j + 1);
    const total = facturadoByClose.get(cs.closes[j]!)! - prev + run.reduce((s, c) => s + (paidIn.get(c) ?? 0), 0);
    let f = prev;
    run.forEach((c, k) => {
      const ch = k === run.length - 1 ? total - Math.round(total / run.length) * (run.length - 1) : Math.round(total / run.length);
      charges.set(c, ch);
      f = f - (paidIn.get(c) ?? 0) + ch;
      fact.set(c, f);
    });
    if (f !== facturadoByClose.get(cs.closes[j]!)) throw new Error(`facturado chain broke at ${cs.closes[j]}`);
    i = j + 1;
  }
  const insStatement = db.prepare(
    `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
       card_last4, card_product, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado,
       monto_pagado_anterior, monto_pagado_anterior_date, next_period_from, next_period_to)
     VALUES (@account_id, @card_group, @source_pdf, @statement_date, @period_from, @period_to, @pay_by,
       @card_last4, 'WORLDMEMBER_MASTER', @layout, @currency, @saldo_anterior, @abono, @compras_cargos, @deuda_total,
       @monto_facturado, @monto_pagado_anterior, NULL, @next_period_from, @next_period_to)`
  );
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, posting_date, merchant, description_merged, country,
       amount_orig, orig_currency, amount_clp, amount_usd, installment_flag, nro_cuota_current, nro_cuota_total,
       valor_cuota_mensual_clp, dedupe_key, parser_row_id, raw_line, origin_card_last4)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?, ?, ?)`
  );
  const last4 = plan.accounts.card.last4;
  let usdBalance = cs.previous.usd_deuda;
  const usdAbonosTotal = [...abonos.values()].flat().reduce((s, a) => s + a.usd, 0);
  const usdCharge = Math.round((cs.next.usd_saldo_anterior - cs.previous.usd_deuda + usdAbonosTotal) * 100) / 100;
  say(`card: USD charge ${usdCharge.toFixed(2)} = next saldo anterior ${cs.next.usd_saldo_anterior} − last deuda ${cs.previous.usd_deuda} + abonos ${usdAbonosTotal.toFixed(2)}`);
  closes.slice(1).forEach((close, i) => {
    const from = closes[i]!;
    const next = closes[i + 2] ?? cs.next.close;
    const src = `reconstruido de correos: ${close} estado de cuenta tarjeta ${last4}`;
    const payBy = addDays(close, cs.pay_by_days);
    const paid = paidIn.get(close) ?? 0;
    const clpId = Number(
      insStatement.run({
        account_id: CARD, card_group: "A", source_pdf: `${src}.pdf`, statement_date: ddmmyyyy(close),
        period_from: ddmmyyyy(from), period_to: ddmmyyyy(close), pay_by: ddmmyyyy(payBy), card_last4: last4,
        layout: "compact", currency: "clp", saldo_anterior: null, abono: -paid, compras_cargos: charges.get(close)!,
        deuda_total: null, monto_facturado: fact.get(close)!, monto_pagado_anterior: -paid,
        next_period_from: ddmmyyyy(close), next_period_to: ddmmyyyy(next),
      }).lastInsertRowid
    );
    let n = 0;
    for (const e of events) {
      if (e.kind !== "card_payment" || e.last4 !== last4 || cycleOf(sentDay(e.mail)) !== close) continue;
      const d = ddmmyyyy(sentDay(e.mail));
      insLine.run(clpId, d, d, "MONTO CANCELADO", "MONTO CANCELADO", null, null, null, -e.amount, null,
        `mail-rebuild|${close}|pago|${n}`, `mail-rebuild|${close}|pago|${n++}`, `${d} MONTO CANCELADO (${mailRef(e.mail)})`, last4);
    }
    // Charges: one line a week of the cycle, no_cuenta (the excel-gap rows carry these months' spending).
    const weeks: string[] = [];
    for (let d = addDays(from, 3); d < close; d = addDays(d, 7)) weeks.push(d);
    const total = charges.get(close)!;
    weeks.forEach((d, k) => {
      const amt = k === weeks.length - 1 ? total - Math.round(total / weeks.length) * (weeks.length - 1) : Math.round(total / weeks.length);
      const key = `mail-rebuild|${close}|cargos|${k}`;
      insLine.run(clpId, ddmmyyyy(d), ddmmyyyy(d), "COMPRAS DEL PERIODO (ESTIMADO)", "COMPRAS DEL PERIODO (ESTIMADO)", "CL",
        null, null, amt, null, key, key, `estimado: facturado − anterior + pagos, repartido por semana`, last4);
      setCategory.run(CARD, `line-pr:${key}`, CATEGORY.no_cuenta);
    });
    // USD: abonos of the cycle, the one estimated charge in the first lost cycle.
    const usdLines = abonos.get(close) ?? [];
    const chargeHere = i === 0 ? usdCharge : 0;
    const abonoSum = usdLines.reduce((s, a) => s + a.usd, 0);
    const saldoAnterior = usdBalance;
    usdBalance = Math.round((usdBalance - abonoSum + chargeHere) * 100) / 100;
    const usdId = Number(
      insStatement.run({
        account_id: CARD, card_group: "INTL", source_pdf: `${src.replace("tarjeta", "tarjeta usd")}.pdf`,
        statement_date: ddmmyyyy(close), period_from: ddmmyyyy(from), period_to: ddmmyyyy(close), pay_by: ddmmyyyy(payBy),
        card_last4: last4, layout: "international_usd", currency: "usd", saldo_anterior: saldoAnterior, abono: -abonoSum,
        compras_cargos: chargeHere, deuda_total: usdBalance, monto_facturado: usdBalance > 0 ? usdBalance : null,
        monto_pagado_anterior: 0, next_period_from: null, next_period_to: null,
      }).lastInsertRowid
    );
    usdLines.forEach((a, k) => {
      const d = ddmmyyyy(a.on);
      const key = `mail-rebuild|${close}|abono-usd|${k}`;
      insLine.run(usdId, d, d, "ABONO DE DIVISAS", "ABONO DE DIVISAS", "CH", a.usd, "usd", 0, -a.usd, key, key, `${d} ABONO DE DIVISAS (correo)`, last4);
    });
    if (chargeHere) {
      const d = ddmmyyyy(cs.usd_charge_on);
      const key = `mail-rebuild|${close}|cargos-usd`;
      insLine.run(usdId, d, d, "COMPRAS INTERNACIONALES (ESTIMADO)", "COMPRAS INTERNACIONALES (ESTIMADO)", "US", chargeHere, "usd", null, chargeHere, key, key,
        `estimado: saldo anterior del ${cs.next.close} − deuda del ${cs.previous.close} + abonos`, last4);
      setCategory.run(CARD, `line-pr:${key}`, CATEGORY.no_cuenta);
    }
    say(
      `  ${close}: facturado ${fmt(fact.get(close)!)}${facturadoByClose.has(close) ? " (mail)" : " (estimated)"}, payments ${fmt(paid)}, charges ${fmt(total)} in ${weeks.length} weekly lines; USD ${saldoAnterior.toFixed(2)} − ${abonoSum.toFixed(2)} + ${chargeHere.toFixed(2)} = ${usdBalance.toFixed(2)}`
    );
  });
  if (Math.abs(usdBalance - cs.next.usd_saldo_anterior) > 0.005) throw new Error(`USD chain ends at ${usdBalance}, next statement says ${cs.next.usd_saldo_anterior}`);

  // 5. Pair the card debits with the card's payment evidence (corriente rows of step 2, plus any vista ones).
  const gapDebitIds = new Set(
    (db.prepare(`SELECT id FROM movements WHERE account_id IN (?, ?) AND from_account_id IS NULL AND occurred_on BETWEEN ? AND ?`)
      .all(CORRIENTE, VISTA, addDays(plan.gap.from, -2), addDays(plan.gap.to, 2)) as { id: number }[]).map((r) => r.id)
  );
  const cands = listCcPaymentMirrorCandidates().filter((c) => gapDebitIds.has(c.out.movement_id) && c.evidence.cc_account_id === CARD);
  const blocked = cands.filter((c) => c.blocked);
  if (blocked.length) throw new Error(`blocked card payment pairs: ${blocked.map((c) => c.out.movement_id).join(", ")}`);
  const paired = convertCcPaymentMirrors(
    cands.map((c) => ({ out_movement_id: c.out.movement_id, statement_line_id: c.evidence.statement_line_id, statement_id: c.evidence.statement_id }))
  ).converted;
  const unpaired = db
    .prepare(
      `SELECT id, occurred_on, amount, note FROM movements WHERE account_id = ? AND from_account_id IS NULL
         AND occurred_on BETWEEN ? AND ? AND (note LIKE 'Traspaso Internet a T. Cr%' OR note LIKE 'Egreso por Compra de Divisas%')`
    )
    .all(CORRIENTE, plan.gap.from, plan.gap.to) as { id: number; occurred_on: string; amount: number }[];
  if (unpaired.length) throw new Error(`card debits left unpaired: ${unpaired.map((u) => `${u.id} ${u.occurred_on} ${fmt(u.amount)}`).join("; ")}`);
  say(`card payments paired: ${paired.length} (${cardDebits.length} corriente debits + ${paired.length - cardDebits.length} vista)`);

  // 6. Real-estate bills onto the mailed payments; the excel-gap rows they replace go.
  const setLink = db.prepare(`UPDATE real_estate_expense_links SET purchase_key = ?, link_source = 'manual' WHERE expense_entry_id = ?`);
  const insLink = db.prepare(`INSERT INTO real_estate_expense_links (expense_entry_id, purchase_key, link_source) VALUES (?, ?, 'manual')`);
  const updBill = db.prepare(`UPDATE expense_entries SET amount_clp = ?, spent_on = ?, note = ? WHERE id = ? AND expense_account_id = ?`);
  const insBill = db.prepare(`INSERT INTO expense_entries (amount_clp, spent_on, category, note, expense_account_id) VALUES (?, ?, ?, ?, ?)`);
  const monthEnd = (ym: string) =>
    `${ym}-${String(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()).padStart(2, "0")}`;
  for (const b of plan.bills) {
    const mv = billPayments.get(`${b.paid.on}|${b.paid.amount}`)!;
    const payee = (db.prepare(`SELECT note FROM movements WHERE id = ?`).get(mv) as { note: string }).note.replace(/ \(correo.*$/, "");
    const note = `Asignado desde compra — ${payee} · ${b.paid.on}`;
    let entry = b.entry_id;
    if (entry == null) {
      entry = Number(insBill.run(b.paid.amount, monthEnd(b.bill_month), b.kind, note, plan.place_expense_account_id).lastInsertRowid);
      insLink.run(entry, `checking-mv:${mv}`);
    } else {
      const old = db.prepare(`SELECT category, amount_clp, spent_on FROM expense_entries WHERE id = ?`).get(entry) as { category: string; amount_clp: number; spent_on: string };
      if (old.category !== b.kind) throw new Error(`bill ${entry} is ${old.category}, plan says ${b.kind}`);
      if (updBill.run(b.paid.amount, monthEnd(b.bill_month), note, entry, plan.place_expense_account_id).changes !== 1) throw new Error(`bill ${entry} not on the place`);
      if (setLink.run(`checking-mv:${mv}`, entry).changes !== 1) throw new Error(`bill ${entry} has no link`);
      if (old.amount_clp !== b.paid.amount || old.spent_on !== monthEnd(b.bill_month))
        say(`  bill ${entry} ${b.kind}: ${old.spent_on} ${fmt(old.amount_clp)} → ${monthEnd(b.bill_month)} ${fmt(b.paid.amount)}`);
    }
  }
  const delExcel = db.prepare(`DELETE FROM expense_entries WHERE id = ? AND note LIKE 'synthetic:excel-gap|%' AND expense_account_id IS NULL`);
  let excelGone = 0;
  for (const id of plan.excel_gap_entries_replaced) {
    const linked = db.prepare(`SELECT expense_entry_id FROM real_estate_expense_links WHERE purchase_key = ?`).get(`manual:${id}`);
    if (linked) throw new Error(`excel-gap row ${id} is still a bill's purchase`);
    excelGone += delExcel.run(id).changes;
  }
  if (excelGone !== plan.excel_gap_entries_replaced.length) throw new Error(`deleted ${excelGone} of ${plan.excel_gap_entries_replaced.length} excel-gap rows`);
  say(`bills: ${plan.bills.length} on mailed payments; ${excelGone} excel-gap rows replaced`);

  // 7. Derived state.
  clearCheckingBalanceCache();
  upsertCreditCardValuationsFromLedger(CARD, { affectedEvidenceFromYmd: plan.card_statements.previous.close });
  recomputeCcBillingMonthBalances(CARD);
  clearAggregationCache();
  const checkpoints = ["2019-06-30", "2019-07-31", "2019-08-31", "2019-09-30", "2019-10-31", "2019-11-30", "2019-12-29", "2019-12-31", "2020-01-31"];
  say(`corriente balance: ${checkpoints.map((d) => `${d} ${fmt(checkingMovementBalanceClpAt(CORRIENTE, d))}`).join(", ")}`);
  say(`vista balance:     ${checkpoints.map((d) => `${d} ${fmt(checkingMovementBalanceClpAt(VISTA, d))}`).join(", ")}`);
  const ignored = events.filter((e): e is Extract<Event, { kind: "ignored" }> => e.kind === "ignored");
  say(`mails: ${events.length}, ignored ${ignored.length}: ${[...new Set(ignored.map((e) => e.why))].join("; ")}`);
  for (const s of report) console.log(s);
  if (!apply) throw new Rollback();
});

try {
  tx.immediate();
  console.log("applied");
} catch (e) {
  if (!(e instanceof Rollback)) throw e;
  console.log("report only — rolled back (pass --apply to write)");
}
