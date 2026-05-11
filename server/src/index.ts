import cors from "cors";
import express from "express";
import { initSchema, db } from "./db.js";

initSchema();

const app = express();
const PORT = Number(process.env.PORT) || 3001;

app.use(cors({ origin: true }));
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

/** Category tree: groups + nested categories */
app.get("/api/meta/asset-tree", (_req, res) => {
  const groups = db
    .prepare(
      `SELECT id, slug, label, sort_order FROM asset_groups ORDER BY sort_order, id`
    )
    .all() as { id: number; slug: string; label: string; sort_order: number }[];

  const cats = db
    .prepare(
      `SELECT id, group_id, slug, label, sort_order FROM categories ORDER BY sort_order, id`
    )
    .all() as { id: number; group_id: number; slug: string; label: string; sort_order: number }[];

  const byGroup = new Map<number, typeof cats>();
  for (const c of cats) {
    const arr = byGroup.get(c.group_id) ?? [];
    arr.push(c);
    byGroup.set(c.group_id, arr);
  }

  res.json({
    groups: groups.map((g) => ({
      ...g,
      categories: byGroup.get(g.id) ?? [],
    })),
  });
});

app.get("/api/accounts", (req, res) => {
  const groupSlug = req.query.group as string | undefined;
  let sql = `
    SELECT a.id, a.name, a.notes, a.created_at,
           c.slug AS category_slug, c.label AS category_label,
           g.slug AS group_slug, g.label AS group_label
    FROM accounts a
    JOIN categories c ON c.id = a.category_id
    JOIN asset_groups g ON g.id = c.group_id
  `;
  const params: string[] = [];
  if (groupSlug) {
    sql += ` WHERE g.slug = ?`;
    params.push(groupSlug);
  }
  sql += ` ORDER BY g.sort_order, c.sort_order, a.name`;
  const rows = db.prepare(sql).all(...params);
  res.json({ accounts: rows });
});

app.post("/api/accounts", (req, res) => {
  const { category_id, name, notes } = req.body as {
    category_id?: number;
    name?: string;
    notes?: string;
  };
  if (!category_id || !name?.trim()) {
    res.status(400).json({ error: "category_id and name required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO accounts (category_id, name, notes) VALUES (?, ?, ?)`
    )
    .run(category_id, name.trim(), notes ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/accounts/:id/summary", (req, res) => {
  const id = Number(req.params.id);
  const deposits = db
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS s FROM movements WHERE account_id = ? AND kind = 'deposit'`
    )
    .get(id) as { s: number };
  const withdrawals = db
    .prepare(
      `SELECT COALESCE(SUM(amount_clp), 0) AS s FROM movements WHERE account_id = ? AND kind = 'withdrawal'`
    )
    .get(id) as { s: number };
  const latest = db
    .prepare(
      `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1`
    )
    .get(id) as { value_clp: number; as_of_date: string } | undefined;
  res.json({
    account_id: id,
    deposits_clp: deposits.s,
    withdrawals_clp: withdrawals.s,
    latest_valuation_clp: latest?.value_clp ?? null,
    latest_valuation_date: latest?.as_of_date ?? null,
  });
});

app.get("/api/accounts/:id/movements", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, kind, amount_clp, occurred_on, note FROM movements WHERE account_id = ? ORDER BY occurred_on DESC, id DESC`
    )
    .all(id);
  res.json({ movements: rows });
});

app.post("/api/accounts/:id/movements", (req, res) => {
  const accountId = Number(req.params.id);
  const { kind, amount_clp, occurred_on, note } = req.body as {
    kind?: string;
    amount_clp?: number;
    occurred_on?: string;
    note?: string;
  };
  if (kind !== "deposit" && kind !== "withdrawal") {
    res.status(400).json({ error: "kind must be deposit or withdrawal" });
    return;
  }
  if (!amount_clp || amount_clp <= 0 || !occurred_on) {
    res.status(400).json({ error: "amount_clp and occurred_on required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO movements (account_id, kind, amount_clp, occurred_on, note) VALUES (?, ?, ?, ?, ?)`
    )
    .run(accountId, kind, amount_clp, occurred_on, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/accounts/:id/valuations", (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT id, as_of_date, value_clp FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC`
    )
    .all(id);
  res.json({ valuations: rows });
});

app.post("/api/accounts/:id/valuations", (req, res) => {
  const accountId = Number(req.params.id);
  const { as_of_date, value_clp } = req.body as { as_of_date?: string; value_clp?: number };
  if (!as_of_date || value_clp === undefined || value_clp === null) {
    res.status(400).json({ error: "as_of_date and value_clp required" });
    return;
  }
  db.prepare(
    `INSERT INTO valuations (account_id, as_of_date, value_clp) VALUES (?, ?, ?)
     ON CONFLICT(account_id, as_of_date) DO UPDATE SET value_clp = excluded.value_clp`
  ).run(accountId, as_of_date, value_clp);
  res.json({ ok: true });
});

function fxOnOrBefore(date: string | null): { date: string; clp_per_usd: number } | null {
  if (!date) return null;
  return (
    (db
      .prepare(
        `SELECT date, clp_per_usd FROM fx_daily WHERE date <= ? ORDER BY date DESC LIMIT 1`
      )
      .get(date) as { date: string; clp_per_usd: number } | undefined) ?? null
  );
}

app.get("/api/dashboard", (req, res) => {
  const accounts = db
    .prepare(
      `
      SELECT a.id, a.name,
             g.slug AS group_slug, g.label AS group_label,
             c.slug AS category_slug, c.label AS category_label
      FROM accounts a
      JOIN categories c ON c.id = a.category_id
      JOIN asset_groups g ON g.id = c.group_id
      ORDER BY g.sort_order, c.sort_order, a.name
    `
    )
    .all() as {
    id: number;
    name: string;
    group_slug: string;
    group_label: string;
    category_slug: string;
    category_label: string;
  }[];

  const depStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_clp), 0) AS s FROM movements WHERE account_id = ? AND kind = 'deposit'`
  );
  const wdwStmt = db.prepare(
    `SELECT COALESCE(SUM(amount_clp), 0) AS s FROM movements WHERE account_id = ? AND kind = 'withdrawal'`
  );
  const valStmt = db.prepare(
    `SELECT value_clp, as_of_date FROM valuations WHERE account_id = ? ORDER BY as_of_date DESC LIMIT 1`
  );

  const includeUsd = req.query.include_usd === "1" || req.query.include_usd === "true";

  const rows = accounts.map((a) => {
    const deposits = (depStmt.get(a.id) as { s: number }).s;
    const withdrawals = (wdwStmt.get(a.id) as { s: number }).s;
    const v = valStmt.get(a.id) as { value_clp: number; as_of_date: string } | undefined;
    const fxRow = includeUsd ? fxOnOrBefore(v?.as_of_date ?? null) : null;
    const current_value_usd =
      includeUsd && v && fxRow ? v.value_clp / fxRow.clp_per_usd : null;
    const fx_date_used = fxRow?.date ?? null;
    const fx_clp_per_usd = fxRow?.clp_per_usd ?? null;
    return {
      account_id: a.id,
      name: a.name,
      group_slug: a.group_slug,
      group_label: a.group_label,
      category_slug: a.category_slug,
      category_label: a.category_label,
      deposits_clp: deposits,
      withdrawals_clp: withdrawals,
      current_value_clp: v?.value_clp ?? null,
      valuation_as_of: v?.as_of_date ?? null,
      current_value_usd,
      fx_clp_per_usd,
      fx_date_used,
    };
  });

  const totalCurrent = rows.reduce((s, r) => s + (r.current_value_clp ?? 0), 0);
  const totalDeposits = rows.reduce((s, r) => s + r.deposits_clp, 0);
  const totalWithdrawals = rows.reduce((s, r) => s + r.withdrawals_clp, 0);
  const totalCurrentUsd = includeUsd
    ? rows.reduce((s, r) => s + (r.current_value_usd ?? 0), 0)
    : null;

  const byGroup = new Map<string, { label: string; value_clp: number; value_usd: number }>();
  for (const r of rows) {
    if (r.current_value_clp == null) continue;
    const cur = byGroup.get(r.group_slug) ?? {
      label: r.group_label,
      value_clp: 0,
      value_usd: 0,
    };
    cur.value_clp += r.current_value_clp;
    if (r.current_value_usd != null) cur.value_usd += r.current_value_usd;
    byGroup.set(r.group_slug, cur);
  }

  res.json({
    totals: {
      current_value_clp: totalCurrent,
      deposits_clp: totalDeposits,
      withdrawals_clp: totalWithdrawals,
      ...(includeUsd ? { current_value_usd: totalCurrentUsd } : {}),
    },
    allocation: [...byGroup.entries()].map(([slug, v]) => ({
      group_slug: slug,
      group_label: v.label,
      value_clp: v.value_clp,
      ...(includeUsd ? { value_usd: v.value_usd } : {}),
    })),
    accounts: rows,
  });
});

app.get("/api/fx/latest", (_req, res) => {
  const row = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 1`)
    .get() as { date: string; clp_per_usd: number } | undefined;
  res.json(row ?? null);
});

app.get("/api/fx", (_req, res) => {
  const rows = db
    .prepare(`SELECT date, clp_per_usd FROM fx_daily ORDER BY date DESC LIMIT 365`)
    .all();
  res.json({ rates: rows });
});

/** Upsert FX: body { date: 'YYYY-MM-DD', clp_per_usd: number } */
app.post("/api/fx", (req, res) => {
  const { date, clp_per_usd } = req.body as { date?: string; clp_per_usd?: number };
  if (!date || !clp_per_usd || clp_per_usd <= 0) {
    res.status(400).json({ error: "date and positive clp_per_usd required" });
    return;
  }
  db.prepare(
    `INSERT INTO fx_daily (date, clp_per_usd) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET clp_per_usd = excluded.clp_per_usd`
  ).run(date, clp_per_usd);
  res.json({ ok: true });
});

app.get("/api/income", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, received_on, source, note FROM income_entries ORDER BY received_on DESC, id DESC`
    )
    .all();
  res.json({ income: rows });
});

app.post("/api/income", (req, res) => {
  const { amount_clp, received_on, source, note } = req.body as {
    amount_clp?: number;
    received_on?: string;
    source?: string;
    note?: string;
  };
  if (amount_clp == null || !received_on) {
    res.status(400).json({ error: "amount_clp and received_on required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO income_entries (amount_clp, received_on, source, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, received_on, source ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

app.get("/api/expenses", (_req, res) => {
  const rows = db
    .prepare(
      `SELECT id, amount_clp, spent_on, category, note, import_batch_id FROM expense_entries ORDER BY spent_on DESC, id DESC`
    )
    .all();
  res.json({ expenses: rows });
});

app.post("/api/expenses", (req, res) => {
  const { amount_clp, spent_on, category, note } = req.body as {
    amount_clp?: number;
    spent_on?: string;
    category?: string;
    note?: string;
  };
  if (!amount_clp || amount_clp <= 0 || !spent_on) {
    res.status(400).json({ error: "positive amount_clp and spent_on required" });
    return;
  }
  const r = db
    .prepare(
      `INSERT INTO expense_entries (amount_clp, spent_on, category, note) VALUES (?, ?, ?, ?)`
    )
    .run(amount_clp, spent_on, category ?? null, note ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

/** Placeholder for future bank CSV / PDF pipeline */
app.post("/api/imports/bank-statement", (req, res) => {
  const { filename, raw_text } = req.body as { filename?: string; raw_text?: string };
  const r = db
    .prepare(
      `INSERT INTO import_batches (kind, filename, status, raw_text) VALUES ('bank_statement', ?, 'pending', ?)`
    )
    .run(filename ?? null, raw_text ?? null);
  res.status(201).json({ id: Number(r.lastInsertRowid), status: "pending" });
});

app.listen(PORT, () => {
  console.log(`nw-tracker API http://localhost:${PORT}`);
});
