/**
 * DAP (depósitos a plazo, BancoSantander Mercado Capitales) — a CLP ledger account under the
 * cash_savings bucket. Money leaves checking into a DAP and returns at maturity with interest; the
 * old sheet only made this visible by parking DAP principal inside the cuenta-ahorro line (the
 * dropped dap_proxy rows). This account holds the principal while a DAP is open so inter-month DAPs
 * appear in month-end net worth (intra-month DAPs are transparent either way, but their rows keep
 * the ledger true). Interest is booked as `savings_earnings` (yield/P&L, not an aporte), so the
 * balance returns to 0 after the last maturity.
 *
 * Reads `cfraser/dap-history.csv` (numero;inicio;vencimiento;monto_inicial;monto_final).
 *
 *   npm run import:dap -w nw-tracker-server
 */
import fs from "node:fs";
import path from "node:path";
import { db } from "../src/db.js";
import { resolveCfraserCsvDir } from "../src/cfraserPaths.js";
import { readSemicolonCsv } from "../src/cfraserCsv.js";

const CASH_SAVINGS_PARENT_ASSET_GROUP_SLUG = "cash_eqs__cash_savings";
const CASH_SAVINGS_PORTFOLIO_GROUP_SLUG = "cash_savings";
const DAP_ASSET_GROUP_SLUG = "cash_eqs__dap";
const DAP_ACCOUNT_NOTES = "import:dap|key=dap_clp";

type DapRow = {
  numero: string;
  inicio: string;
  vencimiento: string;
  monto_inicial: number;
  monto_final: number;
};

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function loadDapCsv(): DapRow[] {
  const fp = path.join(resolveCfraserCsvDir(), "dap-history.csv");
  if (!fs.existsSync(fp)) {
    throw new Error(`import:dap: ${fp} not found`);
  }
  const rows = readSemicolonCsv(fp);
  const out: DapRow[] = [];
  for (const row of rows) {
    const numero = String(row[0] ?? "").trim();
    if (!numero || numero === "numero") continue;
    const inicio = String(row[1] ?? "").trim();
    const vencimiento = String(row[2] ?? "").trim();
    const inicial = Math.round(Number(row[3]));
    const final = Math.round(Number(row[4]));
    if (!YMD_RE.test(inicio) || !YMD_RE.test(vencimiento) || vencimiento < inicio) {
      throw new Error(`import:dap: bad dates for ${numero}: ${inicio} → ${vencimiento}`);
    }
    if (!Number.isFinite(inicial) || !Number.isFinite(final) || inicial <= 0 || final < inicial) {
      throw new Error(`import:dap: bad amounts for ${numero}: ${row[3]} → ${row[4]}`);
    }
    out.push({ numero, inicio, vencimiento, monto_inicial: inicial, monto_final: final });
  }
  if (out.length === 0) throw new Error("import:dap: no rows parsed");
  return out;
}

function ensureDapAccount(): number {
  const existing = db.prepare(`SELECT id FROM accounts WHERE notes = ?`).get(DAP_ACCOUNT_NOTES) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;

  const parent = db
    .prepare(`SELECT id FROM asset_groups WHERE slug = ?`)
    .get(CASH_SAVINGS_PARENT_ASSET_GROUP_SLUG) as { id: number } | undefined;
  if (!parent) throw new Error(`import:dap: missing asset group ${CASH_SAVINGS_PARENT_ASSET_GROUP_SLUG}`);
  const pg = db
    .prepare(`SELECT id FROM portfolio_groups WHERE slug = ?`)
    .get(CASH_SAVINGS_PORTFOLIO_GROUP_SLUG) as { id: number } | undefined;
  if (!pg) throw new Error(`import:dap: missing portfolio group ${CASH_SAVINGS_PORTFOLIO_GROUP_SLUG}`);

  let groupRow = db.prepare(`SELECT id FROM asset_groups WHERE slug = ?`).get(DAP_ASSET_GROUP_SLUG) as
    | { id: number }
    | undefined;
  if (!groupRow) {
    const maxSort = (
      db.prepare(`SELECT COALESCE(MAX(sort_order), 0) AS s FROM asset_groups WHERE parent_id = ?`).get(
        parent.id
      ) as { s: number }
    ).s;
    const r = db
      .prepare(`INSERT INTO asset_groups (slug, label, sort_order, parent_id) VALUES (?, ?, ?, ?)`)
      .run(DAP_ASSET_GROUP_SLUG, "DAP", maxSort + 1, parent.id);
    groupRow = { id: Number(r.lastInsertRowid) };
  }

  const acc = db
    .prepare(
      `INSERT INTO accounts (asset_group_id, name, notes, exclude_from_group_totals, primary_portfolio_group_id)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(groupRow.id, "DAP", DAP_ACCOUNT_NOTES, pg.id);
  const accountId = Number(acc.lastInsertRowid);

  db.prepare(
    `INSERT INTO portfolio_group_items (group_id, item_kind, account_id, sort_order)
     VALUES (?, 'account', ?, ?)`
  ).run(pg.id, accountId, 20);

  return accountId;
}

function main() {
  const rows = loadDapCsv();
  const accountId = ensureDapAccount();

  const insMov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note, flow_kind) VALUES (?, ?, ?, ?, ?)`
  );
  const upsertVal = db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
  );

  type Flow = { date: string; amount: number; note: string; flow_kind: string | null };
  const flows: Flow[] = [];
  for (const r of rows) {
    flows.push({
      date: r.inicio,
      amount: r.monto_inicial,
      note: `import:dap|abono|doc=${r.numero}`,
      flow_kind: null,
    });
    const interes = r.monto_final - r.monto_inicial;
    if (interes > 0) {
      flows.push({
        date: r.vencimiento,
        amount: interes,
        note: `import:dap|interes|doc=${r.numero}`,
        flow_kind: "savings_earnings",
      });
    }
    flows.push({
      date: r.vencimiento,
      amount: -r.monto_final,
      note: `import:dap|retiro|doc=${r.numero}`,
      flow_kind: null,
    });
  }
  flows.sort((a, b) => a.date.localeCompare(b.date));

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM movements WHERE account_id = ?`).run(accountId);
    db.prepare(`DELETE FROM valuations WHERE account_id = ?`).run(accountId);

    let cum = 0;
    for (const f of flows) {
      insMov.run(accountId, f.amount, f.date, f.note, f.flow_kind);
      cum += f.amount;
      upsertVal.run(accountId, f.date, cum);
    }
    if (cum !== 0) {
      console.warn(
        `import:dap: closing balance ${cum.toLocaleString("es-CL")} ≠ 0 — a DAP is still open or the CSV is incomplete`
      );
    }
    console.log(
      `import:dap: account ${accountId}, ${rows.length} DAPs → ${flows.length} movements, closing balance ${cum.toLocaleString("es-CL")}`
    );
  });
  tx();
}

main();
