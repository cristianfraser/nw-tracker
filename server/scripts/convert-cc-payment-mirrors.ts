/**
 * Auto-convert checking↔CC payment mirror pairs (see `ccPaymentMirrors.ts`).
 *
 *   npm run convert:cc-payment-mirrors                 # convert
 *   npm run convert:cc-payment-mirrors -- --dry-run    # list only
 *
 * Converts every unblocked candidate. The matcher is fail-closed (exact amount, ±4-day
 * nearest-date, ambiguity blocks both sides). The transfer takes the CARD's credit date; the
 * checking debit's date stays as its bank posting (`movement_bank_postings`), so a pair across
 * a month boundary converts too — the cartola checks keep reading the debit in its own month.
 */
import {
  convertCcPaymentMirrors,
  listCcPaymentMirrorCandidates,
} from "../src/ccPaymentMirrors.js";
import { loadRootDotenv } from "../src/rootDotenv.js";

loadRootDotenv();
const dryRun = process.argv.includes("--dry-run");

const candidates = listCcPaymentMirrorCandidates();
if (candidates.length === 0) {
  console.log("No CC payment mirror candidates.");
  process.exit(0);
}

const auto = candidates.filter((c) => !c.blocked);
for (const c of candidates) {
  const state = c.blocked ? `[blocked: ${c.blocked_reason}]` : dryRun ? "[would convert]" : "[converting]";
  console.log(
    `  cargo ${c.out.occurred_on} ${String(c.out.amount_clp).padStart(12)} (${c.out.account_name})` +
      ` ↔ abono ${c.evidence.pago_iso} (${c.evidence.cc_account_name}, ${c.evidence.label})` +
      ` skew ${c.skew_days}d ${state}`
  );
}

if (dryRun || auto.length === 0) {
  console.log(`\n${auto.length} convertible candidate(s).${dryRun ? " Re-run without --dry-run to convert." : ""}`);
  process.exit(0);
}

const { converted } = convertCcPaymentMirrors(
  auto.map((c) => ({
    out_movement_id: c.out.movement_id,
    statement_line_id: c.evidence.statement_line_id,
    statement_id: c.evidence.statement_id,
  }))
);
console.log(`\nConverted ${converted.length} pago_tarjeta transfer(s).`);
