/**
 * Write the app behind App Store card charges onto their expense notes, from the receipts and
 * subscription notices `import:apple-mail` stored (`merchantExpenseNotes.ts`). The matcher also
 * runs on every stored mail and every card write; this is the manual pass.
 *
 *   npm run match:app-store-notes -w nw-tracker-server              # report what it would write
 *   npm run match:app-store-notes -w nw-tracker-server -- --apply   # write it
 *
 * Only charges with no note are written.
 */
import { matchMerchantExpenseNotes } from "../src/merchantExpenseNotes.js";

const apply = process.argv.includes("--apply");
const result = matchMerchantExpenseNotes({ apply });

for (const n of result.notes_written) {
  console.log(`  ${n.date}  account ${n.account_id}  ${n.key.padEnd(40)}  «${n.note}»  (${n.basis})`);
}
for (const u of result.unresolved) {
  console.log(`  app not named: receipt ${u.issued_on} — ${u.products.join(", ")}`);
}
console.log(`${result.notes_written.length} note(s) ${apply ? "written" : "would be written (report only; --apply to write)"}.`);
