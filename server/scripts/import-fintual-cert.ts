/**
 * Import the Fintual "certificado de transacciones" into the v2 cert accounts.
 *
 * Rebuilds `import:fintual|cert|movement` rows on the four v2 cert accounts from the
 * certificado CSV installed under `cfraser/` (drop it via `npm run import:cfraser-inbox`).
 * Scoped delete + re-insert — manual movements on the same accounts are preserved.
 *
 * Usage:
 *   npm run import:fintual-cert -w nw-tracker-server
 *   npm run import:fintual-cert -w nw-tracker-server -- --dry-run
 *   IMPORT_MAX_MONTH=2026-06 npm run import:fintual-cert -w nw-tracker-server
 */
import { importFintualCertificado } from "../src/fintualCertImport.js";

const dryRun = process.argv.includes("--dry-run");
const maxMonth = process.env.IMPORT_MAX_MONTH?.trim() || undefined;

const res = importFintualCertificado({ dryRun, maxMonth });

console.log(
  `${dryRun ? "[dry-run] " : ""}import:fintual-cert → ${res.movementsInserted} movements ` +
    `(deleted ${res.movementsDeleted}, preserved ${res.classificationsPreserved} state/traspaso classifications), ` +
    `${res.fundUnitRows} valor-cuota fund_unit_daily rows, ${res.accounts} accounts. Source: ${res.csvPath}`
);
