/**
 * Drop Inmuebles links outside the bill+0/+1/+2 purchase-month window, then auto-link again.
 * Default: also clears prior auto-links and rebuilds them (keeps manual links).
 *
 *   npm run reconcile:real-estate-links -w nw-tracker-server
 *   npm run reconcile:real-estate-links -w nw-tracker-server -- --keep-auto
 */
import "../src/db.js";
import { reconcileRealEstateExpenseLinks } from "../src/realEstateExpenseMatching.js";

const keepAuto = process.argv.includes("--keep-auto");
const result = reconcileRealEstateExpenseLinks({ resetAutoLinks: !keepAuto });
console.log(
  [
    `cleared prior auto-links: ${result.clearedAutoLinks}`,
    `removed outside month window: ${result.removedOutsideWindow}`,
    `removed orphan: ${result.removedOrphan}`,
    `new auto-links: ${result.autoLinked}`,
  ].join("\n")
);
