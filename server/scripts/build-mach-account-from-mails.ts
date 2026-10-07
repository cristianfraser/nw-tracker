/**
 * Builds the MACH account (BCI cuenta vista <account number>), which never had statements, from what
 * records it: MACH's own mails, the card statements and the cuenta corriente.
 *
 *   npx tsx scripts/build-mach-account-from-mails.ts --plan=<plan.json>            # report (rolled back)
 *   npx tsx scripts/build-mach-account-from-mails.ts --plan=<plan.json> --apply
 *
 * What goes in (one transaction; without --apply it is rolled back after the report):
 * - the account: «MACH», CLP, under Checking accounts (`createPanelAccount`);
 * - each card top-up («MACH ONE CLICK» / «MACH WEBPAY ONECLICK» on the card statement): a transfer
 *   card → MACH, flow kind `carga_tarjeta`, dated the card's transaction date; the card lines take
 *   the internal-transfer category (a merchant rule), so they leave gastos;
 * - each withdrawal to the cuenta corriente (its «<your RUT> Transf. <your name> …» credit) and each
 *   wire from it into MACH: MACH's side as a row, then the pair converted to one transfer with the
 *   mirror-pair conversion (the bank row kept in `movement_mirror_merges`);
 * - each «Le pagaste» mail: a MACH debit in the plan's category;
 * - each «Te pagaron» mail: a MACH credit marked as a refund in the plan's category;
 * - stand-in inflows: where the recorded events would take the balance below zero, one credit for
 *   exactly the shortfall, just before (payments to the user MACH did not mail), refunds in the plan's
 *   stand-in category;
 * - a closing debit after the last event, so the account ends at exactly 0, in the plan's category.
 *
 * Every MACH row's note is `import:mach-mail|<mail time | standin | closing | bank>|<description>`
 * (`isMailRebuiltCheckingNote`), which the gastos and income pages read. The plan names the inputs
 * (mail archive, card and corriente rows) and the categories; the script checks every one of them.
 */
import fs from "node:fs";
import { db } from "../src/db.js";
import { createPanelAccount } from "../src/createPanelAccount.js";
import { convertMirrorPairs } from "../src/movementMirrorConvert.js";
import { markCheckingExpenseRefund } from "../src/checkingExpenseRefunds.js";
import { assignFlowExpenseLineCategory } from "../src/assignFlowExpenseLineCategory.js";
import { getCcExpenseCategoryBySlug, normalizeCcExpenseMerchantKey, resolveCcExpensePurchaseKey } from "../src/ccExpenseCategories.js";
import { FLOW_KIND_CARGA_TARJETA } from "../src/movementFlowType.js";
import { checkingGastosMovementPurchaseKey } from "../src/flowsCheckingGastos.js";

type Plan = {
  mail_archive: string;
  card_account_id: number;
  card_merchants: string[];
  corriente_account_id: number;
  /** How the bank prints your own RUT on a credit from your own account. */
  own_rut_note_token: string;
  /** Corriente credits: money leaving MACH to the corriente. */
  withdrawal_movement_ids: number[];
  /** Corriente debits: wires into MACH. */
  wire_movement_ids: number[];
  /** Category per payment, keyed `<sent_at_chile>|<amount>` (amount signed: − paid, + received). */
  categories: Record<string, string>;
  standin_category: string;
  closing_category: string;
};

type Mail = { message_id: string; sent_at_chile: string; from: string; subject: string; text: string };
type Ev = {
  day: string;
  kind: "card_load" | "wire_in" | "withdrawal" | "paid_to" | "paid_by" | "standin" | "closing";
  amount: number; // signed, from MACH's side
  label: string;
  sent_at?: string;
  ref?: number;
};

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const planPath = argv.find((a) => a.startsWith("--plan="))?.slice(7);
if (!planPath) throw new Error("--plan=<plan.json> is required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;

const pesos = (s: string) => {
  if (!/^\d{1,3}(\.\d{3})*$/.test(s)) throw new Error(`not a peso amount: ${s}`);
  return Number(s.replace(/\./g, ""));
};

/** The money mails: «Le pagaste $X a <name>» (out) and «<name> te pagó [tu cobro] [por] $X» (in). */
function mailEvents(): Ev[] {
  const mails = JSON.parse(fs.readFileSync(plan.mail_archive, "utf8")) as Mail[];
  const out: Ev[] = [];
  for (const m of mails) {
    if (!/somosmach\.com$/.test(m.from)) throw new Error(`${m.sent_at_chile}: not a MACH sender ${m.from}`);
    // MACH's template text where no motive was typed («Pago sin motivo…», the 2020 template's footer,
    // «Reacciona en MACH…») is not a motive.
    const motivo = (t: string) => {
      const why = t.match(/Motivo: (.+?) (?:referidos |Enviado|MACH Transactional|Reacciona)/)?.[1]?.trim();
      return !why || /^(?:MACH Transactional|Pago sin motivo|Reacciona en MACH)/.test(why) ? null : why;
    };
    if (m.subject.startsWith("Le pagaste")) {
      const a = m.text.match(/Le pagaste \$([\d.]+) a (.+?) (?:Motivo|Pago)/);
      if (!a) throw new Error(`${m.sent_at_chile} «${m.subject}»: unreadable`);
      const why = motivo(m.text);
      out.push({ day: m.sent_at_chile.slice(0, 10), kind: "paid_to", amount: -pesos(a[1]!), sent_at: m.sent_at_chile, label: `Le pagaste a ${a[2]}${why ? ` — ${why}` : ""}` });
    } else if (m.subject.startsWith("Te pagaron")) {
      const a = m.text.match(/([A-ZÁÉÍÓÚ][\wáéíóúñ]+ [A-ZÁÉÍÓÚ][\wáéíóúñ]+) te pag[oó] (?:tu cobro )?(?:por )?\$([\d.]+)/);
      if (!a) throw new Error(`${m.sent_at_chile} «${m.subject}»: unreadable`);
      const why = motivo(m.text);
      out.push({ day: m.sent_at_chile.slice(0, 10), kind: "paid_by", amount: pesos(a[2]!), sent_at: m.sent_at_chile, label: `${a[1]} te pagó${why ? ` — ${why}` : ""}` });
    }
  }
  return out;
}

function bankEvents(): Ev[] {
  const out: Ev[] = [];
  const merchants = plan.card_merchants.map((m) => m.toUpperCase());
  const cardLines = db
    .prepare(
      `SELECT l.id, l.transaction_date, l.merchant, l.amount_clp
       FROM cc_statement_lines l JOIN cc_statements s ON s.id = l.statement_id
       WHERE s.account_id = ? AND upper(trim(l.merchant)) IN (${merchants.map(() => "?").join(",")})`
    )
    .all(plan.card_account_id, ...merchants) as { id: number; transaction_date: string; merchant: string; amount_clp: number }[];
  for (const l of cardLines) {
    const [d, m, y] = l.transaction_date.split("/");
    const day = `${y!.length === 4 ? y : `20${y}`}-${m}-${d}`;
    if (!(l.amount_clp > 0)) throw new Error(`card line ${l.id}: not a charge`);
    out.push({ day, kind: "card_load", amount: l.amount_clp, ref: l.id, label: `Carga MACH desde tarjeta (${l.merchant})` });
  }
  const row = db.prepare(`SELECT id, account_id, occurred_on, amount, note FROM movements WHERE id = ?`);
  for (const id of plan.withdrawal_movement_ids) {
    const r = row.get(id) as { account_id: number; occurred_on: string; amount: number; note: string } | undefined;
    if (!r || r.account_id !== plan.corriente_account_id || !(r.amount > 0) || !r.note.includes(plan.own_rut_note_token)) {
      throw new Error(`withdrawal ${id}: not a corriente credit from MACH`);
    }
    out.push({ day: r.occurred_on, kind: "withdrawal", amount: -r.amount, ref: id, label: "Retiro a cuenta corriente" });
  }
  for (const id of plan.wire_movement_ids) {
    const r = row.get(id) as { account_id: number; occurred_on: string; amount: number } | undefined;
    if (!r || r.account_id !== plan.corriente_account_id || !(r.amount < 0)) throw new Error(`wire ${id}: not a corriente debit`);
    out.push({ day: r.occurred_on, kind: "wire_in", amount: -r.amount, ref: id, label: "Transferencia desde cuenta corriente" });
  }
  return out;
}

/** In before out on a day; stand-ins where the balance would go below 0; a closing to exactly 0. */
function walk(events: Ev[]): Ev[] {
  const sorted = [...events].sort((a, b) => a.day.localeCompare(b.day) || (a.amount > 0 ? 0 : 1) - (b.amount > 0 ? 0 : 1) || (a.sent_at ?? "").localeCompare(b.sent_at ?? ""));
  const out: Ev[] = [];
  let bal = 0;
  for (const e of sorted) {
    if (bal + e.amount < 0) {
      const s = -(bal + e.amount);
      out.push({ day: e.day, kind: "standin", amount: s, label: "Pagos por MACH no registrados (estimado)" });
      bal += s;
    }
    bal += e.amount;
    out.push(e);
  }
  if (bal !== 0) out.push({ day: out[out.length - 1]!.day, kind: "closing", amount: -bal, label: "Cierre: gasto en MACH no registrado" });
  return out;
}

class RollBack extends Error {}
const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: script console output

try {
  db.transaction(() => {
    for (const slug of [...Object.values(plan.categories), plan.standin_category, plan.closing_category, "checking_internal_transfer"]) {
      if (!getCcExpenseCategoryBySlug(slug)) throw new Error(`unknown category ${slug}`);
    }
    const events = walk([...mailEvents(), ...bankEvents()]);
    const { account_id: mach } = createPanelAccount({
      account: { account_type: "clp_cash", name: "MACH", bucket_slug: "checking_accounts", category_slug: "mach", exclude_from_group_totals: false },
    });

    const single = db.prepare(`INSERT INTO movements (account_id, amount, currency, occurred_on, note) VALUES (?, ?, 'clp', ?, ?)`);
    const transfer = db.prepare(
      `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
       VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?)`
    );
    const pairs: { out_movement_id: number; in_movement_id: number }[] = [];
    const usedKeys = new Set<string>();
    let bal = 0;
    const rows: string[] = [];
    for (const e of events) {
      bal += e.amount;
      let note = `import:mach-mail|${e.sent_at ?? e.kind}|${e.label}`;
      if (e.kind === "card_load") {
        transfer.run(plan.card_account_id, mach, e.amount, e.day, `MACH: carga desde tarjeta (línea ${e.ref})`, FLOW_KIND_CARGA_TARJETA);
      } else if (e.kind === "withdrawal") {
        const id = Number(single.run(mach, e.amount, e.day, `import:mach-mail|bank|${e.label}`).lastInsertRowid);
        pairs.push({ out_movement_id: id, in_movement_id: e.ref! });
      } else if (e.kind === "wire_in") {
        const id = Number(single.run(mach, e.amount, e.day, `import:mach-mail|bank|${e.label}`).lastInsertRowid);
        pairs.push({ out_movement_id: e.ref!, in_movement_id: id });
      } else {
        const id = Number(single.run(mach, e.amount, e.day, note).lastInsertRowid);
        if (e.kind === "paid_to" || e.kind === "paid_by") {
          const key = `${e.sent_at}|${e.amount}`;
          const cat = plan.categories[key];
          if (!cat) throw new Error(`no category in the plan for ${key} (${e.label})`);
          usedKeys.add(key);
          if (e.kind === "paid_by") {
            markCheckingExpenseRefund(id, cat);
          } else if (cat !== "unclassified") {
            // «unclassified» is the absence of a category: nothing to assign.
            assignFlowExpenseLineCategory({ lineId: id, source: "checking", unique: true, categorySlug: cat });
          }
        } else if (e.kind === "standin") {
          markCheckingExpenseRefund(id, plan.standin_category);
        } else if (plan.closing_category !== "unclassified") {
          assignFlowExpenseLineCategory({ lineId: id, source: "checking", unique: true, categorySlug: plan.closing_category });
        }
      }
      rows.push(`  ${e.day}  ${e.kind.padEnd(10)} ${fmt(e.amount).padStart(10)}  ${fmt(bal).padStart(10)}  ${e.label}`);
    }
    // A wire into MACH is the user's own transfer: a category a past pass gave its debit goes, or the
    // mirror conversion (rightly) refuses a «spent» leg.
    for (const id of plan.wire_movement_ids) {
      const key = checkingGastosMovementPurchaseKey(id);
      const had = db
        .prepare(
          `SELECT c.slug FROM cc_expense_unique_purchases u JOIN cc_expense_categories c ON c.id = u.category_id
           WHERE u.account_id = ? AND u.purchase_key = ?`
        )
        .get(plan.corriente_account_id, key) as { slug: string } | undefined;
      if (had) {
        db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`).run(plan.corriente_account_id, key);
        rows.push(`  (wire ${id}: category «${had.slug}» cleared — an internal transfer now)`);
      }
    }
    const unused = Object.keys(plan.categories).filter((k) => !usedKeys.has(k));
    if (unused.length) throw new Error(`plan categories no mail matched: ${unused.join(", ")}`);
    const { converted } = convertMirrorPairs(pairs);
    if (converted.length !== pairs.length) throw new Error(`converted ${converted.length} of ${pairs.length} pairs`);

    // The card's top-up lines are internal transfers, out of gastos.
    const rule = db.prepare(
      `INSERT INTO cc_expense_merchant_categories (account_id, merchant_key, category_id) VALUES (?, ?, ?)
       ON CONFLICT(account_id, merchant_key) DO UPDATE SET category_id = excluded.category_id`
    );
    const internal = getCcExpenseCategoryBySlug("checking_internal_transfer")!.id;
    for (const m of plan.card_merchants) rule.run(plan.card_account_id, normalizeCcExpenseMerchantKey(m), internal);
    // A line's own category (or split) beats the merchant rule, so each top-up line is set too; what
    // it carried before is listed (a hint at what that money was spent on inside MACH).
    const splitsOf = db.prepare(
      `SELECT c.slug, s.amount_clp FROM cc_expense_line_splits s JOIN cc_expense_categories c ON c.id = s.category_id
       WHERE s.source = 'cc' AND s.line_id = ? ORDER BY s.seq`
    );
    const dropSplits = db.prepare(`DELETE FROM cc_expense_line_splits WHERE source = 'cc' AND line_id = ?`);
    rows.push("\n  card top-up lines → internal transfer (category they carried before):");
    for (const e of events.filter((x) => x.kind === "card_load")) {
      const splits = splitsOf.all(e.ref) as { slug: string; amount_clp: number }[];
      dropSplits.run(e.ref);
      const had = db
        .prepare(
          `SELECT COALESCE(c.slug, 'unclassified') AS slug FROM cc_expense_unique_purchases u
           LEFT JOIN cc_expense_categories c ON c.id = u.category_id WHERE u.account_id = ? AND u.purchase_key = ?`
        )
        .get(plan.card_account_id, resolveCcExpensePurchaseKey(e.ref!)) as { slug: string } | undefined;
      assignFlowExpenseLineCategory({ lineId: e.ref!, source: "cc", unique: true, categorySlug: "checking_internal_transfer" });
      rows.push(`    line ${e.ref}  ${e.day}  ${fmt(e.amount).padStart(9)}  ${splits.length ? splits.map((x) => `${x.slug} ${fmt(x.amount_clp)}`).join(" + ") : (had?.slug ?? "(no line category)")}`);
    }

    const finalBal = (db.prepare(`SELECT COALESCE(SUM(CASE WHEN account_id = ? THEN amount WHEN to_account_id = ? THEN amount WHEN from_account_id = ? THEN -amount END), 0) AS b FROM movements WHERE account_id = ? OR to_account_id = ? OR from_account_id = ?`).get(mach, mach, mach, mach, mach, mach) as { b: number }).b;
    console.log(rows.join("\n"));
    const count = (k: Ev["kind"]) => events.filter((e) => e.kind === k);
    const sum = (k: Ev["kind"]) => count(k).reduce((s, e) => s + e.amount, 0);
    console.log(`\nMACH account ${mach}: ${events.length} events; ledger balance at the end ${fmt(finalBal)}`);
    for (const k of ["card_load", "wire_in", "paid_by", "standin", "withdrawal", "paid_to", "closing"] as const) {
      console.log(`  ${k.padEnd(10)} ${String(count(k).length).padStart(3)}  ${fmt(sum(k)).padStart(11)}`);
    }
    console.log(`  ${pairs.length} withdrawal/wire pairs converted to transfers`);
    if (finalBal !== 0) throw new Error(`MACH ends at ${finalBal}, not 0`);
    if (!apply) throw new RollBack();
    console.log("Applied.");
  }).immediate();
} catch (e) {
  if (!(e instanceof RollBack)) throw e;
  console.log("\nReport only (rolled back); --apply to write.");
}
