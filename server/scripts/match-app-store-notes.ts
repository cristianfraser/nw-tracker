/**
 * App Store charges are named by a link the expense lines derive from Apple's receipts and
 * subscription notices (`merchantExpenseNotes.ts`); the matcher no longer writes expense notes.
 * This reports the links and, with `--prune-notes`, retires the notes they make redundant:
 *
 *   npm run match:app-store-notes -w nw-tracker-server                         # report the links
 *   npm run match:app-store-notes -w nw-tracker-server -- --prune-notes        # report the note changes
 *   npm run match:app-store-notes -w nw-tracker-server -- --prune-notes --apply
 *
 * A note equal to its charge's link label (or «guess: <label>») is deleted. A note that says
 * something else stays; when the charge's link rests on a receipt and the note does not mention
 * the app, « · <label>» is appended. A note on a charge with no link is left alone.
 */
import { db } from "../src/db.js";
import { deriveMerchantChargeLinks } from "../src/merchantExpenseNotes.js";

const prune = process.argv.includes("--prune-notes");
const apply = process.argv.includes("--apply");
if (apply && !prune) throw new Error("--apply only goes with --prune-notes");

const result = deriveMerchantChargeLinks();
const receipt = result.links.filter((l) => !l.guess).length;
console.log(`${result.links.length} App Store charge(s) named: ${receipt} by a receipt, ${result.links.length - receipt} inferred.`);
for (const u of result.unresolved) console.log(`  app not named: receipt ${u.issued_on} — ${u.products.join(", ")}`);

if (prune) {
  const noteOf = db.prepare(`SELECT notes FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`);
  const del = db.prepare(`DELETE FROM cc_expense_purchase_notes WHERE account_id = ? AND purchase_key = ?`);
  const set = db.prepare(
    `UPDATE cc_expense_purchase_notes SET notes = ?, updated_at = datetime('now') WHERE account_id = ? AND purchase_key = ?`
  );
  let deleted = 0;
  let appended = 0;
  let kept = 0;
  db.transaction(() => {
    for (const l of result.links) {
      const row = noteOf.get(l.account_id, l.key) as { notes: string } | undefined;
      if (!row) continue;
      const note = row.notes.trim();
      if (note === l.label || note === `guess: ${l.label}`) {
        deleted++;
        if (apply) del.run(l.account_id, l.key);
        continue;
      }
      if (!l.guess && !note.toLowerCase().includes(l.label)) {
        appended++;
        console.log(`  append  ${l.date}  «${note}» → «${note} · ${l.label}»`);
        if (apply) set.run(`${note} · ${l.label}`, l.account_id, l.key);
        continue;
      }
      kept++;
      console.log(`  keep    ${l.date}  «${note}» (link: ${l.guess ? "≈ " : ""}${l.label})`);
    }
  }).immediate();
  console.log(`notes: ${deleted} deleted, ${appended} appended to, ${kept} kept${apply ? "" : " (report only; --apply to write)"}.`);
}
