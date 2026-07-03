import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { db } from "./db.js";
import { buildAllFlows } from "./flowsApi.js";

const NOTE = "vitest-flowsearch";

let aId = 0;
let bId = 0;

function cleanup() {
  db.prepare(`DELETE FROM movements WHERE note LIKE 'vitest-flowsearch%'`).run();
  db.prepare(`DELETE FROM accounts WHERE name LIKE 'vitest-flowsearch-%'`).run();
}

beforeAll(() => {
  cleanup();
  const leaf = (db.prepare(`SELECT id FROM asset_groups LIMIT 1`).get() as { id: number }).id;
  const ins = db.prepare(`INSERT INTO accounts (asset_group_id, name) VALUES (?, ?)`);
  aId = Number(ins.run(leaf, "vitest-flowsearch-alpha").lastInsertRowid);
  bId = Number(ins.run(leaf, "vitest-flowsearch-beta").lastInsertRowid);
  const mov = db.prepare(
    `INSERT INTO movements (account_id, amount_clp, occurred_on, note) VALUES (?,?,?,?)`
  );
  mov.run(aId, 111_003, "2026-05-01", `${NOTE}|PANADERIA SAN CAMILO`);
  mov.run(aId, -222_007, "2026-05-15", `${NOTE}|FARMACIA`);
  mov.run(bId, 333_009, "2026-06-01", `${NOTE}|sueldo`);
  // transfer row: appears from both perspectives
  db.prepare(
    `INSERT INTO movements (account_id, from_account_id, to_account_id, amount_clp, occurred_on, note)
     VALUES (NULL, ?, ?, 444011, '2026-06-10', ?)`
  ).run(aId, bId, `${NOTE}|traspaso`);
});

afterAll(cleanup);

function search(filters: Parameters<typeof buildAllFlows>[0]) {
  return buildAllFlows(filters, 1, 200).rows.filter((r) => r.note?.startsWith(NOTE));
}

describe("buildAllFlows (global search)", () => {
  it("matches q against the note", () => {
    const rows = search({ q: "panaderia san" });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amount_clp).toBe(111_003);
  });

  it("matches q against the account name", () => {
    const rows = search({ q: "vitest-flowsearch-beta" });
    // beta's own deposit + the transfer from beta's perspective; alpha's perspective
    // also matches via counterpart name.
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.note?.includes("sueldo"))).toBe(true);
    expect(rows.some((r) => r.note?.includes("traspaso"))).toBe(true);
  });

  it("applies inclusive date bounds", () => {
    const rows = search({ q: "vitest-flowsearch", date_from: "2026-05-15", date_to: "2026-06-01" });
    const notes = rows.map((r) => r.note);
    expect(notes.some((n) => n?.includes("FARMACIA"))).toBe(true);
    expect(notes.some((n) => n?.includes("sueldo"))).toBe(true);
    expect(notes.some((n) => n?.includes("PANADERIA"))).toBe(false);
    expect(notes.some((n) => n?.includes("traspaso"))).toBe(false);
  });

  it("amount_exact matches rounded |amount|; min/max bound it", () => {
    expect(search({ amount_exact: 222_007 })).toHaveLength(1);
    const ranged = search({ q: "vitest-flowsearch", amount_min: 200_000, amount_max: 400_000 });
    expect(ranged.map((r) => Math.round(Math.abs(r.amount_clp))).sort()).toEqual([222_007, 333_009]);
  });

  it("filters by account_id and includes both transfer perspectives overall", () => {
    const alpha = search({ account_id: aId });
    expect(alpha.every((r) => r.account_id === aId)).toBe(true);
    expect(alpha.some((r) => r.note?.includes("traspaso"))).toBe(true);
    const all = search({ q: "traspaso" });
    expect(all).toHaveLength(2); // one row per perspective
  });

  it("returns pagination shape and filter options", () => {
    const page = buildAllFlows({ q: "vitest-flowsearch" }, 1, 2);
    expect(page.total).toBeGreaterThanOrEqual(5);
    expect(page.rows).toHaveLength(2);
    expect(page.page).toBe(1);
    expect(page.filter_options.accounts.length).toBeGreaterThanOrEqual(2);
  });
});
