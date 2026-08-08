/**
 * Auto-convert checking↔CC payment mirror pairs (see `ccPaymentMirrors.ts`).
 *
 *   npm run convert:cc-payment-mirrors                 # convert
 *   npm run convert:cc-payment-mirrors -- --dry-run    # list only
 *
 * Converts every unblocked candidate whose checking debit and card credit share a calendar
 * month. The matcher is already fail-closed (exact amount, ±4-day nearest-date, ambiguity
 * blocks both sides), so the month guard is the only extra condition for unattended use: the
 * transfer takes the CARD's credit date, and moving a checking leg into the prior month would
 * put it in a cartola period whose saldo_final excludes it (the checking-anchor rule).
 * Month-straddling pairs stay visible as manual candidates in /panel/mirror-pairs.
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

const auto = candidates.filter(
  (c) => !c.blocked && c.out.occurred_on.slice(0, 7) === c.evidence.pago_iso.slice(0, 7)
);
for (const c of candidates) {
  const state = c.blocked
    ? `[blocked: ${c.blocked_reason}]`
    : auto.includes(c)
      ? dryRun
        ? "[would convert]"
        : "[converting]"
      : "[month straddle — left for /panel/mirror-pairs]";
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
