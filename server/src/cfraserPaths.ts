import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

/** Directory for a statement PDF (`<last4>/clp` or `<last4>/usd` only). */
export function ccStatementPdfSearchDirs(cardLast4: string, usd: boolean): string[] {
  return [resolveCcStatementSlotDir(cardLast4, usd)];
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
