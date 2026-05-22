/**
 * Build pre-2020 cuenta corriente synthetic history (Jun 2017 – Dec 2019).
 *
 *   npm run import:checking-pre2020-synthetic -w nw-tracker-server
 *   npm run import:checking-pre2020-synthetic -w nw-tracker-server -- --dry-run
 *
 * Requires `cfraser.xlsx` (Table 1-2-1 cuenta corriente column) and `import:excel` movements
 * in crypto, Fintual RN, cuenta ahorro (Depósitos), APV, etc.
 */
import { buildPre2020SyntheticHistory } from "../src/checkingPre2020Synthetic.js";

function main() {
  const dryRun = process.argv.includes("--dry-run");
  const result = buildPre2020SyntheticHistory({ dryRun });
  if (result.mirror_inserted === 0 && result.real_inserted === 0 && !dryRun) {
    console.warn("No synthetic movements inserted — check Excel path and source deposits.");
  }
}

main();
