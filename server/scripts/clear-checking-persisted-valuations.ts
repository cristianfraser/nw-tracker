/**
 * One-off cleanup: remove persisted `valuations` rows for cuenta corriente.
 * Balances are computed from movements at API/chart time (not stored).
 *
 *   npm run clear:checking-persisted-valuations -w nw-tracker-server
 */
import {
  clearCheckingAccountValuations,
} from "../src/checkingCartolaBalances.js";
import { checkingAccountId } from "../src/checkingCartolaImport.js";

function main() {
  const accountId = checkingAccountId();
  const cleared = clearCheckingAccountValuations(accountId);
  console.log(
    `Account ${accountId}: removed ${cleared} persisted valuation row(s). Use movement cumsum at runtime.`
  );
}

main();
