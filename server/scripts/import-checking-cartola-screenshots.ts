/**
 * Import checking cartolas transcribed from screenshots.
 *
 *   npm run import:checking-cartola-screenshots -w nw-tracker-server
 *   npm run import:checking-cartola-screenshots -w nw-tracker-server -- --dry-run
 *
 * Source: server/scripts/checking-cartola-screenshot-data.json
 * Skips months already in checking_cartola_imports unless --wipe is passed.
 */
import { importCheckingCartolasFromScreenshots } from "../src/checkingCartolaImport.js";

function main() {
  const wipe = process.argv.includes("--wipe");
  const dryRun = process.argv.includes("--dry-run");

  const result = importCheckingCartolasFromScreenshots({ wipe, dryRun });

  if (result.errors.length) {
    process.exit(1);
  }
}

main();
