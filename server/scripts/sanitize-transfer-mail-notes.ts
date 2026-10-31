/**
 * One-off data hygiene for transfer mails (2026-10-31). Report-first: without --apply it prints
 * what it would change and writes nothing; --apply writes everything in one IMMEDIATE transaction.
 *
 *  1. Movements written from a transfer mail carried «Transf a <payee> (<bank>)» as their note's
 *     description; the bank lives in the notice the movement is paired with, so the description
 *     drops it («Transf a <payee>», as `transferNoticeMovementNote` now writes). Only notes whose
 *     parenthesis is exactly the paired notice's bank are touched. The checking line's merchant key
 *     comes from that description, so a merchant rule on the old key is copied to the new one (a
 *     different rule already on the new key is a conflict: that movement is left alone).
 *  2. Transfer notices stored with UTF-8 read as Latin-1 («SebastiÃ¡n») are repaired
 *     (`repairMojibake`, which the notice import now applies on the way in), and so are the notes
 *     of the movements written from them.
 *
 *   npx tsx scripts/sanitize-transfer-mail-notes.ts [--apply]   (from server/)
 */
import { db } from "../src/db.js";
import { cartolaDescriptionFromNote, MAIL_REBUILT_NOTE_PREFIXES } from "../src/checkingDescriptionPredicates.js";
import { normalizeCcExpenseMerchantKey } from "../src/ccExpenseCategories.js";
import { repairMojibake } from "../src/textRepair.js";

const apply = process.argv.includes("--apply");

// ---- 1 + 2b: mail-written movement notes -------------------------------------------------------
type MovementRow = { id: number; note: string; account_id: number | null; from_account_id: number | null; to_bank: string | null; checking_account_id: number | null };
const movements = db
  .prepare(
    `SELECT m.id, m.note, m.account_id, m.from_account_id,
            (SELECT n.to_bank FROM movement_transfer_notices t JOIN bank_transfer_notices n USING (message_id)
              WHERE t.movement_id = m.id AND n.kind <> 'incoming' LIMIT 1) AS to_bank,
            (SELECT t.account_id FROM movement_transfer_notices t WHERE t.movement_id = m.id LIMIT 1) AS checking_account_id
     FROM movements m
     WHERE ${MAIL_REBUILT_NOTE_PREFIXES.map(() => "m.note LIKE ?").join(" OR ")}`
  )
  .all(...MAIL_REBUILT_NOTE_PREFIXES.map((p) => `${p}%`)) as MovementRow[];

type NoteChange = { id: number; account_id: number | null; from: string; to: string; oldKey: string; newKey: string; reason: string };
const noteChanges: NoteChange[] = [];
const skipped: string[] = [];
for (const m of movements) {
  let note = repairMojibake(m.note);
  const reasons: string[] = note !== m.note ? ["encoding"] : [];
  const description = cartolaDescriptionFromNote(note);
  const head = /^(Transf a .+?) \(([^()]+)\)( — .*)?$/.exec(description);
  if (head) {
    if (m.to_bank && head[2] === repairMojibake(m.to_bank)) {
      const newDescription = `${head[1]}${head[3] ?? ""}`;
      note = note.slice(0, note.length - description.length) + newDescription;
      reasons.push("bank");
    } else {
      skipped.push(`  movement ${m.id}: «${description}» — ${m.to_bank ? `paired notice's bank is «${m.to_bank}»` : "no paired notice"}, left as is`);
    }
  }
  if (note === m.note) continue;
  const accountId = m.checking_account_id ?? m.account_id ?? m.from_account_id;
  noteChanges.push({
    id: m.id,
    account_id: accountId,
    from: m.note,
    to: note,
    oldKey: normalizeCcExpenseMerchantKey(cartolaDescriptionFromNote(m.note)),
    newKey: normalizeCcExpenseMerchantKey(cartolaDescriptionFromNote(note)),
    reason: reasons.join("+"),
  });
}

// Merchant rules to carry over to the new keys.
const ruleFor = db.prepare(`SELECT category_id FROM cc_expense_merchant_categories WHERE account_id = ? AND merchant_key = ?`);
type RuleMove = { account_id: number; from: string; to: string; category_id: number };
const ruleMoves = new Map<string, RuleMove>();
const conflicts: string[] = [];
for (const c of [...noteChanges]) {
  if (c.account_id == null || c.oldKey === c.newKey) continue;
  const old = ruleFor.get(c.account_id, c.oldKey) as { category_id: number } | undefined;
  if (!old) continue;
  const atNew = ruleFor.get(c.account_id, c.newKey) as { category_id: number } | undefined;
  const pending = ruleMoves.get(`${c.account_id}|${c.newKey}`);
  const target = atNew?.category_id ?? pending?.category_id;
  if (target != null && target !== old.category_id) {
    conflicts.push(`  movement ${c.id}: rule «${c.oldKey}» (category ${old.category_id}) vs «${c.newKey}» (category ${target}) — note left as is`);
    noteChanges.splice(noteChanges.indexOf(c), 1);
    continue;
  }
  if (!atNew) ruleMoves.set(`${c.account_id}|${c.newKey}`, { account_id: c.account_id, from: c.oldKey, to: c.newKey, category_id: old.category_id });
}

// ---- 2a: notices with broken encoding -----------------------------------------------------------
const TEXT_COLUMNS = ["subject", "comment", "from_name", "from_bank", "from_account_type", "to_name", "to_bank", "to_account_type"] as const;
const notices = db.prepare(`SELECT message_id, ${TEXT_COLUMNS.join(", ")} FROM bank_transfer_notices`).all() as Record<string, string | null>[];
const noticeChanges: { message_id: string; column: string; from: string; to: string }[] = [];
for (const n of notices) {
  for (const col of TEXT_COLUMNS) {
    const v = n[col];
    if (v == null) continue;
    const fixed = repairMojibake(v);
    if (fixed !== v) noticeChanges.push({ message_id: String(n.message_id), column: col, from: v, to: fixed });
  }
}

// ---- report -------------------------------------------------------------------------------------
console.log(`Movement notes: ${noteChanges.length} to rewrite (of ${movements.length} mail-written movements)`);
for (const c of noteChanges) console.log(`  ${c.id} [${c.reason}]\n    ${c.from}\n  → ${c.to}`);
if (skipped.length) console.log(`\nLeft as is (${skipped.length}):\n${skipped.join("\n")}`);
if (conflicts.length) console.log(`\nMerchant-rule conflicts (${conflicts.length}):\n${conflicts.join("\n")}`);
console.log(`\nMerchant rules copied to the new key: ${ruleMoves.size}`);
for (const r of ruleMoves.values()) console.log(`  account ${r.account_id}: «${r.from}» → «${r.to}» (category ${r.category_id})`);
console.log(`\nTransfer notices with broken encoding: ${noticeChanges.length} field(s)`);
for (const c of noticeChanges) console.log(`  ${c.message_id} ${c.column}: «${c.from}» → «${c.to}»`);

if (!apply) {
  console.log("\nReport only; run with --apply to write.");
} else {
  db.transaction(() => {
    const setNote = db.prepare(`UPDATE movements SET note = ? WHERE id = ? AND note = ?`);
    for (const c of noteChanges) {
      if (setNote.run(c.to, c.id, c.from).changes !== 1) throw new Error(`movement ${c.id} changed while running`);
    }
    const addRule = db.prepare(`INSERT INTO cc_expense_merchant_categories (account_id, merchant_key, category_id) VALUES (?, ?, ?)`);
    for (const r of ruleMoves.values()) addRule.run(r.account_id, r.to, r.category_id);
    for (const c of noticeChanges) {
      db.prepare(`UPDATE bank_transfer_notices SET ${c.column} = ? WHERE message_id = ?`).run(c.to, c.message_id);
    }
  }).immediate();
  console.log(`\nWrote ${noteChanges.length} note(s), ${ruleMoves.size} rule(s), ${noticeChanges.length} notice field(s).`);
}
