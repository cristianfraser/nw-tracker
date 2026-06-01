import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeCcImportCardLast4 } from "./ccConsolidatedCards.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEPTO_CSV = "depto-dividendos.csv";

function hasDeptoCsv(dir: string): boolean {
  return fs.existsSync(path.join(dir, DEPTO_CSV));
}

/**
 * Directory with Numbers-exported CSVs (`depto-dividendos.csv`, `net worth-stocks.csv`, …).
 *
 * **`CFRASER_CSV_DIR`** (optional): absolute path to that folder. Set it in the shell before starting
 * the API, e.g. `export CFRASER_CSV_DIR=/path/to/cfraser` — the server does not load a `.env` file by default.
 * If unset, or set but missing `depto-dividendos.csv`, resolution falls through to the repo’s `cfraser/`
 * next to `server/`, then `process.cwd()/cfraser`, then `../cfraser` from cwd.
 */
export function resolveCfraserCsvDir(): string {
  const env = process.env.CFRASER_CSV_DIR?.trim();
  if (env) {
    const resolved = path.resolve(env);
    if (hasDeptoCsv(resolved)) return resolved;
  }
  const fromBundle = path.resolve(__dirname, "..", "..", "cfraser");
  if (hasDeptoCsv(fromBundle)) return fromBundle;
  const cwdHere = path.resolve(process.cwd(), "cfraser");
  if (hasDeptoCsv(cwdHere)) return cwdHere;
  const cwdParent = path.resolve(process.cwd(), "..", "cfraser");
  if (hasDeptoCsv(cwdParent)) return cwdParent;
  if (env) return path.resolve(env);
  return fromBundle;
}

export function resolveDeptoDividendosCsvPath(): string {
  return path.join(resolveCfraserCsvDir(), DEPTO_CSV);
}

/** Credit-card statement PDF root (`cfraser/credit-card-statements/`). */
export function resolveCfraserPdfsDir(): string {
  const env = process.env.CFRASER_PDFS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(__dirname, "..", "..", "cfraser", "credit-card-statements");
}

/** `credit-card-statements/<last4>/clp|usd/` for archived statement PDFs. */
export function resolveCcStatementSlotDir(cardLast4: string, usd: boolean): string {
  const last4 = String(cardLast4 ?? "").trim();
  if (!/^\d{4}$/.test(last4)) {
    throw new Error(`resolveCcStatementSlotDir: invalid card last4 "${cardLast4}"`);
  }
  return path.join(resolveCfraserPdfsDir(), last4, usd ? "usd" : "clp");
}

/** Directory for a statement PDF (`<last4>/clp|usd`, redirected master slot, then `legacy/clp|usd`). */
export function ccStatementPdfSearchDirs(cardLast4: string, usd: boolean): string[] {
  const last4 = String(cardLast4 ?? "").trim();
  const masterLast4 = normalizeCcImportCardLast4(last4);
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const key of [last4, masterLast4]) {
    if (!/^\d{4}$/.test(key)) continue;
    const slot = resolveCcStatementSlotDir(key, usd);
    if (seen.has(slot)) continue;
    seen.add(slot);
    dirs.push(slot);
  }
  const legacy = path.join(resolveCfraserPdfsDir(), "legacy", usd ? "usd" : "clp");
  dirs.push(legacy);
  return dirs;
}

/** Drop zone for new PDFs, cartola xlsx, etc. (`cfraser/inbox/`; legacy `cfraser/pdfs/`). */
export function resolveCfraserInboxDir(): string {
  const env = process.env.CFRASER_INBOX_DIR?.trim();
  if (env) return path.resolve(env);
  const cfraser = resolveCfraserCsvDir();
  const inbox = path.join(cfraser, "inbox");
  const legacy = path.join(cfraser, "pdfs");
  if (fs.existsSync(inbox)) return inbox;
  if (fs.existsSync(legacy)) return legacy;
  return inbox;
}

/** Santander checking-account cartola `.xlsx` files (`cfraser/excels/cuenta corriente/`). */
export function resolveCfraserCheckingCartolasDir(): string {
  const env = process.env.CFRASER_CHECKING_CARTOLAS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(__dirname, "..", "..", "cfraser", "excels", "cuenta corriente");
}

/** Santander checking-account cartola PDFs (`cfraser/cartolas-cuenta-corriente/`). */
export function resolveCfraserCheckingCartolaPdfsDir(): string {
  const env = process.env.CFRASER_CHECKING_CARTOLA_PDFS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(__dirname, "..", "..", "cfraser", "cartolas-cuenta-corriente");
}

/** Santander cuenta vista (CUENTAMATICA) cartola PDFs (`cfraser/cartolas-cuenta-vista/`). */
export function resolveCfraserCuentaVistaCartolaPdfsDir(): string {
  const env = process.env.CFRASER_CUENTA_VISTA_PDFS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(__dirname, "..", "..", "cfraser", "cartolas-cuenta-vista");
}
