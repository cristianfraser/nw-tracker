import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyVendorCatalogChange } from "./vendorCatalogChange.js";
import { foldVendorName } from "./vendorCatalogMatch.js";

/** The four tables the change reads and writes, with categories by slug. */
/** `merchants`: a merchant, or [merchant, origin plastic] for a line another plastic made. */
function fixture(merchants: (string | [string, string])[], rules: [string, string][]) {
  const dbi = new Database(":memory:");
  dbi.exec(`
    CREATE TABLE vendor_catalog (match_kind TEXT, pattern TEXT, display TEXT, source TEXT, UNIQUE (match_kind, pattern, source));
    CREATE TABLE cc_expense_categories (id INTEGER PRIMARY KEY, slug TEXT UNIQUE);
    CREATE TABLE expense_category_rules (id INTEGER PRIMARY KEY, vendor TEXT, link_kind TEXT NOT NULL DEFAULT '', link_key TEXT NOT NULL DEFAULT '',
      category_id INTEGER, UNIQUE (vendor, link_kind, link_key));
    CREATE TABLE cc_statements (id INTEGER PRIMARY KEY, card_last4 TEXT);
    CREATE TABLE cc_statement_lines (id INTEGER PRIMARY KEY, statement_id INTEGER, merchant TEXT, origin_card_last4 TEXT);
    INSERT INTO cc_statements (id, card_last4) VALUES (1, '4242');
    CREATE TABLE cc_expense_line_categories (statement_line_id INTEGER PRIMARY KEY, category_id INTEGER);
  `);
  const cat = dbi.prepare(`INSERT INTO cc_expense_categories (slug) VALUES (?)`);
  for (const s of ["supermarket", "food", "healthcare"]) cat.run(s);
  const id = (slug: string) => (dbi.prepare(`SELECT id FROM cc_expense_categories WHERE slug = ?`).get(slug) as { id: number }).id;
  for (const m of merchants) {
    const [merchant, origin] = typeof m === "string" ? [m, "4242"] : m;
    dbi.prepare(`INSERT INTO cc_statement_lines (statement_id, merchant, origin_card_last4) VALUES (1, ?, ?)`).run(merchant, origin);
  }
  for (const [vendor, slug] of rules) dbi.prepare(`INSERT INTO expense_category_rules (vendor, category_id) VALUES (?, ?)`).run(vendor, id(slug));
  const rulesNow = () =>
    Object.fromEntries(
      (dbi.prepare(`SELECT r.vendor, c.slug FROM expense_category_rules r JOIN cc_expense_categories c ON c.id = r.category_id`).all() as {
        vendor: string;
        slug: string;
      }[]).map((r) => [r.vendor, r.slug])
    );
  const overrides = () =>
    (dbi.prepare(
      `SELECT l.merchant, c.slug FROM cc_expense_line_categories o JOIN cc_statement_lines l ON l.id = o.statement_line_id
       JOIN cc_expense_categories c ON c.id = o.category_id ORDER BY l.id`
    ).all() as { merchant: string; slug: string }[]).map((r) => `${r.merchant}=${r.slug}`);
  return { dbi, rulesNow, overrides };
}

const entry = (kind: "branch" | "prefix" | "exact", pattern: string, display: string) => ({
  kind,
  pattern: foldVendorName(pattern),
  display,
  source: "seed" as const,
});

describe("applyVendorCatalogChange", () => {
  it("gives a merged brand the category most lines had, and a line that had another keeps it", () => {
    const f = fixture(
      ["OKM CENTRO", "OKM CENTRO", "OKM CENTRO", "OKM NORTE", "OKM SUR", "OK MARKET ORIENTE"],
      [
        ["OKM CENTRO", "supermarket"],
        ["OKM NORTE", "food"],
        ["OK MARKET", "supermarket"],
      ]
    );
    f.dbi.prepare(`INSERT INTO vendor_catalog VALUES ('branch', 'OK MARKET', 'OK Market', 'seed')`).run();
    const r = applyVendorCatalogChange(f.dbi, { remove: [], upsert: [entry("branch", "OKM", "Oxxo")] });
    expect(f.rulesNow()).toEqual({ OXXO: "supermarket", "OK MARKET": "supermarket" });
    expect(f.overrides()).toEqual(["OKM NORTE=food"]);
    expect(r.newlyCategorized).toEqual([{ merchant: "OKM SUR", category: "supermarket", lines: 1 }]);
    expect(r.rulesRemoved.map((x) => x.vendor).sort()).toEqual(["OKM CENTRO", "OKM NORTE"]);
  });

  it("keeps an existing rule on the new key and moves nothing when a name changes no key", () => {
    const f = fixture(["SB 731", "SB 733", "JUMBO BILBAO"], [
      ["SB 731", "healthcare"],
      ["SALCOBRAND", "healthcare"],
      ["JUMBO BILBAO", "supermarket"],
    ]);
    const r = applyVendorCatalogChange(f.dbi, { remove: [], upsert: [entry("branch", "SB", "Salcobrand")] });
    expect(f.rulesNow()).toEqual({ SALCOBRAND: "healthcare", "JUMBO BILBAO": "supermarket" });
    expect(f.overrides()).toEqual([]);
    expect(r.rulesAdded).toEqual([]);
  });

  it("gives an exact «Brand (branch)» entry its brand's rule", () => {
    const f = fixture(["ESQUINA 1", "OKM CENTRO"], [
      ["ESQUINA 1", "supermarket"],
      ["OXXO", "supermarket"],
    ]);
    applyVendorCatalogChange(f.dbi, {
      remove: [],
      upsert: [entry("branch", "OKM", "Oxxo"), { kind: "exact", pattern: "ESQUINA 1", display: "Oxxo (Esquina 1)", source: "user" }],
    });
    expect(f.rulesNow()).toEqual({ OXXO: "supermarket" });
  });

  it("drops a rule only an additional cardholder's lines reach, and lets them vote for nothing", () => {
    // 4999 is the fixture registry's additional card.
    const f = fixture(
      [
        ["PARRILLA UNO CENTRO", "4999"],
        ["PARRILLA UNO NORTE", "4999"],
        "PARRILLA UNO NORTE",
        ["OKM CENTRO", "4999"],
        "OKM CENTRO",
      ],
      [
        ["PARRILLA UNO CENTRO", "food"],
        ["OKM CENTRO", "supermarket"],
      ]
    );
    const r = applyVendorCatalogChange(f.dbi, {
      remove: [],
      upsert: [entry("branch", "PARRILLA UNO", "Parrilla Uno"), entry("branch", "OKM", "Oxxo")],
    });
    expect(r.rulesFromAdditionalCard).toEqual([{ vendor: "PARRILLA UNO CENTRO", category: "food", lines: 1 }]);
    expect(f.rulesNow()).toEqual({ OXXO: "supermarket" });
    expect(r.newlyCategorized).toEqual([]);
    expect(f.overrides()).toEqual([]);
  });

  it("refuses a pattern that is not folded", () => {
    const f = fixture([], []);
    expect(() => applyVendorCatalogChange(f.dbi, { remove: [], upsert: [{ kind: "exact", pattern: "Rosen", display: "Rosen", source: "seed" }] })).toThrow(
      /not folded/
    );
  });
});
