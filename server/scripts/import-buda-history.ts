/**
 * Buda CLP wallet — a *buffer* cash account under the crypto bucket. Money flows in from checking
 * (abono), out to buy coins, back in from selling coins, and out to checking (retiro). It is valued
 * like any cash account (balance = cumulative signed movements) and shows 0 P/L (no passive growth —
 * every movement is a capital flow). Coin-only transfers to external wallets are ignored (an
 * unexplained loss from the app's perspective), and Buda fees are ignored (abono amount = buy price).
 *
 * Reads the parsed ledger from `cfraser/buda-history.csv` (produced from `cfraser/buda history.rtf`).
 *
 *   npm run import:buda -w nw-tracker-server
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CRYPTO_ASSET_GROUP_ID = 11; // brokerage_crypto
const CRYPTO_PORTFOLIO_GROUP_ID = 5; // brokerage_crypto (bucket)
const BUDA_ASSET_GROUP_SLUG = "brokerage_crypto__buda_clp";
const BUDA_ACCOUNT_NOTES = "import:buda|key=buda_clp";

type LedgerRow = { date: string; kind: string; status: string; coin: string; coin_amount: string; clp: string };

function loadBudaCsv(): LedgerRow[] {
  const dir = resolveCfraserCsvDir();
  const file = path.join(dir, "buda-history.csv");
  const text = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8")
    : fs.readFileSync(path.resolve(__dirname, "..", "..", "cfraser", "buda-history.csv"), "utf8");
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0]!.split(",");
  return lines.slice(1).map((l) => {
    const cells = l.split(",");
    const row: Record<string, string> = {};
    header.forEach((h, i) => (row[h] = cells[i] ?? ""));
    return row as unknown as LedgerRow;
  });
}

/** Signed CLP effect on the Buda wallet, or null when the row doesn't touch the CLP balance. */
function budaClpDelta(r: LedgerRow): { amount: number; tag: string } | null {
  const clp = Math.round(Number(r.clp || 0));
  if (!Number.isFinite(clp) || clp === 0) return null;
  switch (r.kind) {
    case "abono_clp":
      return r.status === "Abonado" ? { amount: clp, tag: "abono" } : null; // bank → Buda (skip Rechazado)
    case "sell":
      return { amount: clp, tag: "sell" }; // coin → Buda
    case "buy":
      return { amount: -clp, tag: "buy" }; // Buda → coin
    case "retiro_clp":
      return { amount: -clp, tag: "retiro" }; // Buda → bank
    default:
      return null; // coin_out / coin_in / coin_swap don't move CLP
  }
}

function ensureBudaAccount(): number {
  const existing = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(BUDA_ACCOUNT_NOTES) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  let groupRow = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(BUDA_ASSET_GROUP_SLUG) as
    | { id: number }
    | undefined;
  if (!groupRow) {
    const maxSort = (
      db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS s FROM asset_groups WHERE parent_id = ?`).get(
        CRYPTO_ASSET_GROUP_ID
      ) as { s: number }
    ).s;
    const r = db
      .prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`)
      .run(BUDA_ASSET_GROUP_SLUG, "Buda CLP", maxSort + 1, CRYPTO_ASSET_GROUP_ID);
    groupRow = { id: Number(r.lastInsertRowid) };
  }

  const acc = db
    .prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals, primary_portfolio_group_id)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(groupRow.id, "Buda CLP", BUDA_ACCOUNT_NOTES, CRYPTO_PORTFOLIO_GROUP_ID);
  const accountId = Number(acc.lastInsertRowid);

  db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order)
     VALUES (?, 'account', ?, ?)`
  ).run(CRYPTO_PORTFOLIO_GROUP_ID, accountId, 20);

  return accountId;
}

function main() {
  const rows = loadBudaCsv();
  const accountId = ensureBudaAccount();

  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?)`
  );
  const upsertVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value, currency) VALUES (?, ?, ?, 'clp')
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value = excluded.value, currency = excluded.currency`
  );

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);

    const flows = rows
      .map((r) => ({ r, d: budaClpDelta(r) }))
      .filter((x): x is { r: LedgerRow; d: { amount: number; tag: string } } => x.d != null)
      .sort((a, b) => a.r.date.localeCompare(b.r.date));

    let cum = 0;
    let n = 0;
    for (const { r, d } of flows) {
      insMov.run(accountId, d.amount, r.date, `import:buda|${d.tag}`);
      cum += d.amount;
      upsertVal.run(accountId, r.date, cum);
      n += 1;
    }
    console.log(`import:buda: account ${accountId}, ${n} CLP movements, closing balance ${Math.round(cum).toLocaleString("es-CL")}`);
  });
  tx();
}

main();
