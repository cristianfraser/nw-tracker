/**
 * Builds the CMR Falabella card (·0876, open 2019-07 → 2021-06) from its monthly statements and
 * pairs the checking debits that paid it.
 *
 *   npx tsx scripts/import-cmr-statements.ts --plan=<plan.json>            # report (rolled back)
 *   npx tsx scripts/import-cmr-statements.ts --plan=<plan.json> --apply
 *
 * Inputs (personal data, `cfraser/cmr/`): the statements CMR mailed (EstadodeCuenta@cmr.cl, PDFs
 * encrypted with the RUT without its check digit), decrypted with qpdf and read with
 * `pdftotext -layout` into `cfraser/cmr/text/*.txt`; 19 statements (2019-09, 2020-11 → 2021-02 were
 * never mailed — the balance either side shows they carried no lines). The plan names the card
 * account, the categories its purchases take (keyed `<YYYY-MM-DD>|<amount>`) and the MACH stand-in
 * a card top-up replaces.
 *
 * What goes in (one IMMEDIATE transaction; without --apply it is rolled back after the report):
 * - the card master: «cmr ·<last4>», import key `credit_card_master|cmr|<last4>`, cycle 15 → 14,
 *   retired from the nav (it closed in 2021);
 * - one statement per PDF, its lines as printed. Each statement must reproduce its printed
 *   «Monto total facturado a pagar» as the previous one plus its lines, or nothing is written.
 *   Payments («Pago Eecc Internet Boton Santander») are stored as merchant «PAGO», the card
 *   convention, and a refund («Devolucion Compras») as «NOTA DE CREDITO», so it annuls its purchase;
 *   a purchase's merchant drops its «Boleta N» (kept in the raw line); the «Ajuste de sencillo»
 *   rounding pairs take the internal-transfer category;
 * - the checking debits that paid it («PAGO EN LINEA (PROM.) CMR FALABELLA»): converted to
 *   `pago_tarjeta` transfers through the card-payment mirror conversion, every one of them;
 *   the categories a past pass gave those debits are dropped (the purchases carry the spending);
 * - a card top-up to MACH («Mach One Click»): the MACH stand-in credit it replaces goes, a
 *   `carga_tarjeta` transfer card → MACH takes its place, and the card line is an internal transfer;
 * - the categories of the plan on the purchase lines;
 * - month-end anchors = the running sum of the lines (see step 7), checked day by day.
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { parseChileanNumber } from "../src/chileanNumber.js";
import { convertCcPaymentMirrors, listCcPaymentMirrorCandidates } from "../src/ccPaymentMirrors.js";
import { accountMarkClpAtYmd } from "../src/accountMarkClpAtYmd.js";
import { recomputeCcBillingMonthBalances } from "../src/ccBillingBalances.js";
import { checkingGastosMovementPurchaseKey } from "../src/flowsCheckingGastos.js";
import { assignFlowExpenseLineCategory } from "../src/assignFlowExpenseLineCategory.js";
import { getCcExpenseCategoryBySlug } from "../src/ccExpenseCategories.js";
import { FLOW_KIND_CARGA_TARJETA } from "../src/movementFlowType.js";
import { seedCreditCardTree } from "../src/seedCreditCardTree.js";
import { clearAggregationCache } from "../src/aggregationCache.js";
import { clearCheckingBalanceCache } from "../src/checkingCartolaBalances.js";
import { ccMasterImportKeyPrefix } from "../src/ccIssuers.js";

type Plan = {
  last4: string;
  text_dir: string;
  mach_account_id: number;
  mach_standin_movement_id: number;
  categories: Record<string, string>;
};

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const planPath = args.find((a) => a.startsWith("--plan="))?.slice("--plan=".length);
if (!planPath) throw new Error("--plan=<plan.json> is required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8")) as Plan;

const DATE = String.raw`(\d{2}/\d{2}/\d{4})`;
const iso = (ddmmyyyy: string) => `${ddmmyyyy.slice(6)}-${ddmmyyyy.slice(3, 5)}-${ddmmyyyy.slice(0, 2)}`;
const fmt = (n: number) => Math.round(n).toLocaleString("es-CL"); // convention-ok: script console output

type Line = {
  section: "operations" | "voluntary" | "charges";
  place: string | null;
  date: string;
  description: string;
  amount: number;
  raw: string;
};
type Statement = {
  file: string;
  period_from: string;
  period_to: string;
  pay_by: string;
  next_from: string;
  next_to: string;
  billed: number;
  lines: Line[];
};

function parseStatement(file: string, text: string): Statement {
  const one = (re: RegExp, what: string) => {
    const m = text.match(re);
    if (!m) throw new Error(`${file}: no ${what}`);
    return m;
  };
  const period = one(new RegExp(`Período Facturado\\s+${DATE}\\s+${DATE}`), "billed period");
  const next = one(new RegExp(`Próximo Período a Facturar\\s+${DATE}\\s+${DATE}`), "next period");
  const lines: Line[] = [];
  let section: Line["section"] | null = null;
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (s.startsWith("2.1 ")) section = "operations";
    else if (s.startsWith("2.2 ")) section = "voluntary";
    else if (s.startsWith("2.3 ")) section = "charges";
    else if (s.startsWith("III.")) section = null;
    if (!section || s.startsWith("2.")) continue;
    if ((s.match(/\d{2}\/\d{2}\/\d{4}/g) ?? []).length !== 1 || /Costo Monetario|Fecha Facturaci/.test(s)) continue;
    // Place · date · description · [T|A] · amount of the operation · [total · cuotas · first charge · this month's charge]
    const m = s.match(
      new RegExp(
        String.raw`^(?:(.*?)\s{2,})?${DATE}\s+(.+?)\s{2,}(?:([TA])\s+)?(-?[\d.]+)(?:\s+(-?[\d.]+))?(?:\s+(\d{2}/\d{2}))?(?:\s+([a-z]{3}-\d{4}))?(?:\s+(-?[\d.]+))?\s*$`
      )
    );
    if (!m) throw new Error(`${file}: unreadable line «${s}»`);
    const [, place, date, desc, , op, , cuotas, , charge] = m;
    if (cuotas && !/^01\/0[01]$/.test(cuotas)) throw new Error(`${file}: a purchase in cuotas (${cuotas}) — not modeled`);
    lines.push({
      section,
      place: place?.trim() || null,
      date: date!,
      description: desc!.trim(),
      amount: parseChileanNumber(charge ?? op!),
      raw: s.replace(/\s{2,}/g, " "),
    });
  }
  return {
    file,
    period_from: period[1]!,
    period_to: period[2]!,
    pay_by: one(new RegExp(`Pagar Hasta\\s+${DATE}`), "pay-by")[1]!,
    next_from: next[1]!,
    next_to: next[2]!,
    billed: parseChileanNumber(one(/Monto total facturado a pagar\s+(-?[\d.]+)/, "billed total")[1]!),
    lines,
  };
}

const textDir = path.join(resolveCfraserCsvDir(), plan.text_dir);
const statements = fs
  .readdirSync(textDir)
  .filter((f) => f.endsWith(".txt"))
  .map((f) => parseStatement(f, fs.readFileSync(path.join(textDir, f), "utf8")))
  .sort((a, b) => iso(a.period_to).localeCompare(iso(b.period_to)));

const isPayment = (l: Line) => l.section === "charges" && /^Pago\b/i.test(l.description);
const isRefund = (l: Line) => /^Devolucion\b/i.test(l.description) && l.amount < 0;
const isRounding = (l: Line) => /^Ajuste\s+(?:De\s+)?Sencillo\b/i.test(l.description);
/** Payments and refunds take the names every card uses (`isCcPaymentMerchant`, `isNotaDeCreditoMerchant`). */
const merchantOf = (l: Line) =>
  isPayment(l) ? "PAGO" : isRefund(l) ? "NOTA DE CREDITO" : l.description.replace(/\s+Boleta\s+\d+$/i, "");

class Rollback extends Error {}
const report: string[] = [];
const say = (s: string) => report.push(s);

const tx = db.transaction(() => {
  const importKey = `${ccMasterImportKeyPrefix("cmr")}${plan.last4}`;
  if (db.prepare(`SELECT 1 FROM accounts WHERE import_key = ?`).get(importKey)) throw new Error(`${importKey} already exists`);

  // 1. The statements chain: each billed total = the previous one + its lines.
  let billed = 0;
  for (const s of statements) {
    const sum = s.lines.reduce((t, l) => t + l.amount, 0);
    if (billed + sum !== s.billed) {
      throw new Error(`${s.file}: previous billed ${billed} + lines ${sum} ≠ printed ${s.billed}`);
    }
    billed = s.billed;
  }
  say(`${statements.length} statements, ${statements.reduce((t, s) => t + s.lines.length, 0)} lines; each reproduces its billed total`);

  // 2. The card master.
  const assetGroup = db.prepare(`SELECT id FROM asset_groups WHERE slug = 'credit_cards__credit_card'`).get() as { id: number };
  const card = Number(
    db.prepare(`INSERT INTO accounts (asset_group_id, name, notes, import_key) VALUES (?, ?, ?, ?)`)
      .run(assetGroup.id, `cmr ·${plan.last4}`, importKey, importKey).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO credit_card_account_config (account_id, billing_cycle_start_day, billing_cycle_end_day, card_last4, nav_retired)
     VALUES (?, 15, 14, ?, 1)`
  ).run(card, plan.last4);
  say(`card master: account ${card}`);

  // 3. Statements and lines.
  const insStatement = db.prepare(
    `INSERT INTO cc_statements (account_id, card_group, source_pdf, statement_date, period_from, period_to, pay_by,
       card_last4, card_product, layout, currency, saldo_anterior, abono, compras_cargos, deuda_total, monto_facturado,
       monto_pagado_anterior, monto_pagado_anterior_date, next_period_from, next_period_to)
     VALUES (?, 'CMR', ?, ?, ?, ?, ?, ?, 'CMR MASTERCARD', 'compact', 'clp', ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`
  );
  const insLine = db.prepare(
    `INSERT INTO cc_statement_lines (statement_id, transaction_date, posting_date, merchant, description_merged, country,
       amount_orig, orig_currency, amount_clp, amount_usd, installment_flag, nro_cuota_current, nro_cuota_total,
       valor_cuota_mensual_clp, dedupe_key, parser_row_id, raw_line, origin_card_last4)
     VALUES (?, ?, ?, ?, ?, 'CL', NULL, NULL, ?, NULL, 0, 0, 0, 0, ?, ?, ?, ?)`
  );
  const lineIdByKey = new Map<string, { id: number; line: Line }>();
  const roundingLineIds: number[] = [];
  let previous = 0;
  for (const s of statements) {
    const paid = s.lines.filter(isPayment).reduce((t, l) => t + l.amount, 0);
    const statementId = Number(
      insStatement.run(card, `import:cmr|${s.file.replace(/\.txt$/, ".pdf")}`, s.period_to, s.period_from, s.period_to, s.pay_by,
        plan.last4, previous, paid, s.billed - previous - paid, s.billed, s.billed, s.next_from, s.next_to).lastInsertRowid
    );
    s.lines.forEach((l, n) => {
      const key = `cmr|${iso(s.period_to)}|${n}`;
      const id = Number(
        insLine.run(statementId, l.date, l.date, merchantOf(l), [l.place, l.description].filter(Boolean).join(" | "),
          l.amount, key, key, l.raw, plan.last4).lastInsertRowid
      );
      if (isRounding(l)) roundingLineIds.push(id);
      else if (!isPayment(l)) {
        const k = `${iso(l.date)}|${l.amount}`;
        if (lineIdByKey.has(k)) throw new Error(`two lines ${k}: a plan key must name one`);
        lineIdByKey.set(k, { id, line: l });
      }
    });
    previous = s.billed;
  }

  // 4. The checking debits that paid it.
  const debits = db
    .prepare(
      `SELECT id, account_id, occurred_on, amount FROM movements
       WHERE account_id IS NOT NULL AND from_account_id IS NULL AND note LIKE '%CMR FALABE%' ORDER BY occurred_on`
    )
    .all() as { id: number; account_id: number; occurred_on: string; amount: number }[];
  const catOf = db.prepare(
    `SELECT c.slug FROM cc_expense_unique_purchases u LEFT JOIN cc_expense_categories c ON c.id = u.category_id
     WHERE u.account_id = ? AND u.purchase_key = ?`
  );
  const dropCat = db.prepare(`DELETE FROM cc_expense_unique_purchases WHERE account_id = ? AND purchase_key = ?`);
  const dropSplits = db.prepare(`DELETE FROM cc_expense_line_splits WHERE source = 'checking' AND line_id = ?`);
  for (const d of debits) {
    const key = checkingGastosMovementPurchaseKey(d.id);
    const had = (catOf.get(d.account_id, key) as { slug: string | null } | undefined)?.slug;
    dropCat.run(d.account_id, key);
    dropSplits.run(d.id);
    say(`  debit ${d.id} ${d.occurred_on} ${fmt(-d.amount).padStart(8)}  (was «${had ?? "—"}»)`);
  }
  const cands = listCcPaymentMirrorCandidates().filter((c) => c.evidence.cc_account_id === card);
  const blocked = cands.filter((c) => c.blocked);
  if (blocked.length) throw new Error(`blocked payment pairs: ${blocked.map((c) => c.out.movement_id).join(", ")}`);
  const { converted } = convertCcPaymentMirrors(
    cands.map((c) => ({ out_movement_id: c.out.movement_id, statement_line_id: c.evidence.statement_line_id, statement_id: c.evidence.statement_id }))
  );
  const convertedIds = new Set(converted.map((c) => c.out_movement_id));
  const unpaired = debits.filter((d) => !convertedIds.has(d.id));
  if (unpaired.length) throw new Error(`debits left unpaired: ${unpaired.map((d) => `${d.id} ${d.occurred_on} ${d.amount}`).join("; ")}`);
  say(`payments: ${converted.length} debits → pago_tarjeta transfers`);

  // 5. The top-up to MACH replaces the MACH stand-in.
  const topUps = [...lineIdByKey.values()].filter((v) => /^Mach\b/i.test(v.line.description));
  if (topUps.length !== 1) throw new Error(`expected one MACH top-up line, found ${topUps.length}`);
  const topUp = topUps[0]!;
  const standin = db
    .prepare(`SELECT occurred_on, amount, note FROM movements WHERE id = ? AND account_id = ?`)
    .get(plan.mach_standin_movement_id, plan.mach_account_id) as { occurred_on: string; amount: number; note: string } | undefined;
  if (!standin || !standin.note.startsWith("import:mach-mail|standin|") || standin.amount !== topUp.line.amount || standin.occurred_on !== iso(topUp.line.date)) {
    throw new Error(`movement ${plan.mach_standin_movement_id} is not the MACH stand-in of ${iso(topUp.line.date)} ${topUp.line.amount}`);
  }
  db.prepare(`DELETE FROM movements WHERE id = ?`).run(plan.mach_standin_movement_id);
  db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount, currency, occurred_on, note, flow_kind)
     VALUES (NULL, ?, ?, ?, 'clp', ?, ?, ?)`
  ).run(card, plan.mach_account_id, topUp.line.amount, iso(topUp.line.date), `MACH: carga desde tarjeta CMR (línea ${topUp.id})`, FLOW_KIND_CARGA_TARJETA);
  assignFlowExpenseLineCategory({ lineId: topUp.id, source: "cc", unique: true, categorySlug: "checking_internal_transfer" });
  const machLow = db
    .prepare(
      `SELECT MIN(bal) AS low, (SELECT SUM(CASE WHEN account_id = @m THEN amount WHEN to_account_id = @m THEN amount ELSE -amount END)
         FROM movements WHERE @m IN (account_id, from_account_id, to_account_id)) AS final
       FROM (SELECT SUM(CASE WHEN account_id = @m THEN amount WHEN to_account_id = @m THEN amount ELSE -amount END)
               OVER (ORDER BY occurred_on, CASE WHEN account_id = @m THEN amount WHEN to_account_id = @m THEN amount ELSE -amount END DESC, id) AS bal
             FROM movements WHERE @m IN (account_id, from_account_id, to_account_id))`
    )
    .get({ m: plan.mach_account_id }) as { low: number; final: number };
  if (machLow.final !== 0 || machLow.low < 0) throw new Error(`MACH after the swap: low ${machLow.low}, final ${machLow.final}`);
  say(`MACH: stand-in ${plan.mach_standin_movement_id} → carga_tarjeta from the card, ${fmt(topUp.line.amount)} on ${iso(topUp.line.date)}`);

  // 6. Purchase categories.
  for (const [key, slug] of Object.entries(plan.categories)) {
    const hit = lineIdByKey.get(key);
    if (!hit) throw new Error(`plan category for ${key}: no such line`);
    if (!getCcExpenseCategoryBySlug(slug)) throw new Error(`unknown category ${slug}`);
    if (slug !== "unclassified") assignFlowExpenseLineCategory({ lineId: hit.id, source: "cc", unique: true, categorySlug: slug });
  }
  // «Ajuste de sencillo» moves the peso rounding from one statement to the next: not spending.
  for (const id of roundingLineIds) {
    assignFlowExpenseLineCategory({ lineId: id, source: "cc", unique: true, categorySlug: "checking_internal_transfer" });
  }
  for (const [key, v] of lineIdByKey) {
    if (v === topUp || isRounding(v.line)) continue;
    say(`  ${key.padEnd(20)} ${(plan.categories[key] ?? "—").padEnd(14)} ${v.line.description}`);
  }

  // 7. Derived state.
  seedCreditCardTree();
  clearCheckingBalanceCache();
  // The card's balance on a day is the running sum of its lines: the statements chain from 0 with
  // nothing missing, and CMR's payments settle the same period's purchases, which the billing
  // detail (built for cards whose payments settle the previous facturación, and for plans) does not
  // model — it writes no anchors for a card without plans. The anchors are the month-ends of that
  // sum; the owed walk adds the lines after each one, so every day reads the running sum.
  const linesByDay = statements.flatMap((s) => s.lines.map((l) => ({ day: iso(l.date), amount: l.amount })));
  const runningAt = (day: string) => linesByDay.filter((l) => l.day <= day).reduce((t, l) => t + l.amount, 0);
  const lastDay = iso(statements.at(-1)!.period_to);
  const insAnchor = db.prepare(`INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')`);
  for (let t = Date.parse(`${iso(statements[0]!.period_from).slice(0, 7)}-01T00:00:00Z`) - 864e5; ; t += 864e5) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (new Date(t + 864e5).toISOString().slice(8, 10) !== "01") continue;
    insAnchor.run(card, day, runningAt(day));
    if (day > lastDay) break;
  }
  recomputeCcBillingMonthBalances(card);
  clearAggregationCache();
  for (let t = Date.parse(`${iso(statements[0]!.period_from)}T00:00:00Z`) - 864e5; ; t += 864e5) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > lastDay && t > Date.parse(`${lastDay}T00:00:00Z`) + 40 * 864e5) break;
    const mark = accountMarkClpAtYmd(card, day)?.value_clp;
    if (Math.round(mark ?? Number.NaN) !== runningAt(day)) throw new Error(`card on ${day}: mark ${mark}, running sum ${runningAt(day)}`);
  }
  const peak = Math.max(...linesByDay.map((l) => runningAt(l.day)));
  say(`balance: every day matches the running sum of the lines; highest ${fmt(peak)}, ${fmt(runningAt(lastDay))} at the last close`);
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
