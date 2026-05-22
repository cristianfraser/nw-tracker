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

/** Credit-card statement PDFs (`cfraser/credit-card-statements/`, `yyyy-mm-dd estado de cuenta tarjeta….pdf`). */
export function resolveCfraserPdfsDir(): string {
  const env = process.env.CFRASER_PDFS_DIR?.trim();
  if (env) return path.resolve(env);
  return path.resolve(__dirname, "..", "..", "cfraser", "credit-card-statements");
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
