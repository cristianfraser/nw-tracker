/**
 * Changing the vendor catalog without moving any line's category (2026-11-12).
 *
 * A category rule is keyed on the vendor (`vendorRuleKey`: the catalog's brand for a merchant, else
 * its cleaned name), so a new name changes the key a merchant's lines look up: «SB 731» becomes
 * «SALCOBRAND», «OKM <branch>» becomes «OXXO», and the rule they had stops reaching them. Every catalog
 * change goes through `applyVendorCatalogChange`, which carries the rules across:
 *
 *   - for every merchant the ledger holds (each card line's merchant, and every rule's own vendor,
 *     which stands for the checking descriptions and pastes that wrote it), the category the general
 *     rules gave it before the change;
 *   - each new key with no rule gets one: the category most of its lines had (merchants with no
 *     category do not vote; ties go to the lowest category id);
 *   - a card line whose category that rule would change keeps it as its own (a per-line override,
 *     `cc_expense_line_categories`), so a branch filed as food stays food under a supermarket brand;
 *     a merchant with no category takes the brand's;
 *   - a rule nothing reaches any more is deleted, a specific rule (vendor + link) moves with its
 *     vendor;
 *   - an additional cardholder's lines (`isAdditionalCardExpenseLine`) carry their own category
 *     («Único», additional_card), so they never vote, and a general rule only they reach — written
 *     from them before their category became their own — is deleted: it would file the user's own
 *     purchase at that merchant as the cardholder's (a restaurant filed «no cuenta» because the cardholder ate there).
 *
 * Pure apart from the handle it is given, so a migration hook can run it while `db.ts` is loading.
 */
import type { Database as DatabaseType } from "better-sqlite3";
import { vendorRuleKey, vendorRuleKeyCandidates } from "./bankMerchantName.js";
import { isAdditionalCardExpenseLine } from "./ccAdditionalCardLine.js";
import {
  foldVendorName,
  vendorCatalogFromEntries,
  type VendorCatalog,
  type VendorCatalogEntry,
  type VendorCatalogOptions,
} from "./vendorCatalogMatch.js";

export type VendorCatalogChange = {
  /** Rows to remove: (kind, pattern, source). */
  remove: Pick<VendorCatalogEntry, "kind" | "pattern" | "source">[];
  /** Rows to write (patterns already folded); an existing row of the same kind, pattern and source is replaced. */
  upsert: VendorCatalogEntry[];
};

export type VendorCatalogChangeReport = {
  /** New general rules: vendor → category slug, with the merchants whose lines voted. */
  rulesAdded: { vendor: string; category: string; from: string[] }[];
  /** General rules only an additional cardholder's lines reached. */
  rulesFromAdditionalCard: { vendor: string; category: string; lines: number }[];
  /** Rules nothing reaches any more. */
  rulesRemoved: { vendor: string; link_kind: string; link_key: string; category: string }[];
  /** Specific rules moved to their vendor's new key. */
  specificMoved: { from: string; to: string; link_kind: string; link_key: string }[];
  /** Card lines that keep their category as their own. */
  lineOverrides: { statement_line_id: number; merchant: string; category: string }[];
  /** Merchants with no category before that now take their brand's. */
  newlyCategorized: { merchant: string; category: string; lines: number }[];
  /** Merchants with no card line whose category changes (checking descriptions): reported, not kept. */
  unkept: { merchant: string; before: string; after: string | null }[];
};

type RuleRow = { id: number; vendor: string; link_kind: string; link_key: string; category_id: number };

function loadCatalog(dbi: DatabaseType, opts?: VendorCatalogOptions): VendorCatalog {
  return vendorCatalogFromEntries(
    dbi.prepare(`SELECT match_kind AS kind, pattern, display, source FROM vendor_catalog`).all() as VendorCatalogEntry[],
    opts
  );
}

function firstHit(name: string, catalog: VendorCatalog, general: ReadonlyMap<string, number>): number | null {
  for (const v of vendorRuleKeyCandidates(name, catalog)) {
    const c = general.get(v);
    if (c != null) return c;
  }
  return null;
}

export function applyVendorCatalogChange(
  dbi: DatabaseType,
  change: VendorCatalogChange,
  /** How the catalog read before the change (migration 325: exact brands were their whole display). */
  beforeOpts?: VendorCatalogOptions
): VendorCatalogChangeReport {
  const before = loadCatalog(dbi, beforeOpts);

  const del = dbi.prepare(`DELETE FROM vendor_catalog WHERE match_kind = ? AND pattern = ? AND source = ?`);
  for (const r of change.remove) del.run(r.kind, r.pattern, r.source);
  const up = dbi.prepare(
    `INSERT INTO vendor_catalog (match_kind, pattern, display, source) VALUES (?, ?, ?, ?)
     ON CONFLICT (match_kind, pattern, source) DO UPDATE SET display = excluded.display`
  );
  for (const e of change.upsert) {
    if (e.kind !== "rut" && e.pattern !== foldVendorName(e.pattern)) throw new Error(`catalog pattern «${e.pattern}» is not folded`);
    up.run(e.kind, e.pattern, e.display, e.source);
  }

  const after = loadCatalog(dbi);
  return carryCategoryRules(dbi, before, after);
}

export function carryCategoryRules(
  dbi: DatabaseType,
  before: VendorCatalog,
  after: VendorCatalog,
  additionalCardLast4s?: readonly string[]
): VendorCatalogChangeReport {
  const report: VendorCatalogChangeReport = {
    rulesAdded: [],
    rulesFromAdditionalCard: [],
    rulesRemoved: [],
    specificMoved: [],
    lineOverrides: [],
    newlyCategorized: [],
    unkept: [],
  };
  const slugOf = new Map(
    (dbi.prepare(`SELECT id, slug FROM cc_expense_categories`).all() as { id: number; slug: string }[]).map((r) => [r.id, r.slug])
  );
  const slug = (id: number | null) => (id == null ? null : (slugOf.get(id) ?? String(id)));
  const rules = dbi.prepare(`SELECT id, vendor, link_kind, link_key, category_id FROM expense_category_rules`).all() as RuleRow[];
  const general = new Map(rules.filter((r) => r.link_kind === "").map((r) => [r.vendor, r.category_id]));

  // Every merchant the ledger names, with its card lines; an additional cardholder's lines apart.
  const lines = new Map<string, number[]>();
  const additionalByMerchant = new Map<string, number>();
  for (const r of dbi
    .prepare(
      `SELECT l.id, l.merchant, l.origin_card_last4 AS origin, s.card_last4 AS card FROM cc_statement_lines l
       JOIN cc_statements s ON s.id = l.statement_id WHERE l.merchant IS NOT NULL AND l.merchant <> ''`
    )
    .all() as { id: number; merchant: string; origin: string | null; card: string | null }[]) {
    if (isAdditionalCardExpenseLine(r.origin, r.card, additionalCardLast4s)) {
      additionalByMerchant.set(r.merchant, (additionalByMerchant.get(r.merchant) ?? 0) + 1);
      continue;
    }
    const list = lines.get(r.merchant) ?? [];
    list.push(r.id);
    lines.set(r.merchant, list);
  }

  // A general rule only the cardholder's lines reach goes before anything votes.
  const ownReach = new Set([...lines.keys()].flatMap((m) => vendorRuleKeyCandidates(m, before)));
  const additionalReach = new Map<string, number>();
  for (const [m, n] of additionalByMerchant) {
    for (const v of vendorRuleKeyCandidates(m, before)) additionalReach.set(v, (additionalReach.get(v) ?? 0) + n);
  }
  const delRuleById = dbi.prepare(`DELETE FROM expense_category_rules WHERE id = ?`);
  for (const r of rules) {
    if (r.link_kind !== "" || ownReach.has(r.vendor) || !additionalReach.has(r.vendor)) continue;
    delRuleById.run(r.id);
    general.delete(r.vendor);
    report.rulesFromAdditionalCard.push({ vendor: r.vendor, category: slug(r.category_id)!, lines: additionalReach.get(r.vendor)! });
  }
  const liveRules = rules.filter((r) => r.link_kind !== "" || general.has(r.vendor));

  for (const r of liveRules) if (!lines.has(r.vendor)) lines.set(r.vendor, []);

  type Name = { name: string; lineIds: number[]; before: number | null; newKey: string };
  const names: Name[] = [];
  for (const [name, lineIds] of lines) {
    const newKey = vendorRuleKey(name, after);
    if (!newKey) continue;
    names.push({ name, lineIds, before: firstHit(name, before, general), newKey });
  }

  // A new key with no rule takes the category most of its lines had.
  const votes = new Map<string, Map<number, number>>();
  const voters = new Map<string, string[]>();
  for (const n of names) {
    if (n.before == null || general.has(n.newKey)) continue;
    if (vendorRuleKey(n.name, before) === n.newKey) continue;
    const v = votes.get(n.newKey) ?? new Map<number, number>();
    v.set(n.before, (v.get(n.before) ?? 0) + Math.max(1, n.lineIds.length));
    votes.set(n.newKey, v);
    voters.set(n.newKey, [...(voters.get(n.newKey) ?? []), n.name]);
  }
  const insRule = dbi.prepare(`INSERT INTO expense_category_rules (vendor, category_id) VALUES (?, ?)`);
  for (const [vendor, v] of [...votes].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [categoryId] = [...v].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]!;
    insRule.run(vendor, categoryId);
    general.set(vendor, categoryId);
    report.rulesAdded.push({ vendor, category: slug(categoryId)!, from: voters.get(vendor)!.sort() });
  }

  // Each merchant's category after the change; a card line keeps its own when it moves.
  const insOverride = dbi.prepare(`INSERT OR IGNORE INTO cc_expense_line_categories (statement_line_id, category_id) VALUES (?, ?)`);
  for (const n of names) {
    const now = firstHit(n.name, after, general);
    if (now === n.before) continue;
    if (n.before == null) {
      if (n.lineIds.length > 0) report.newlyCategorized.push({ merchant: n.name, category: slug(now)!, lines: n.lineIds.length });
      continue;
    }
    if (n.lineIds.length === 0) {
      report.unkept.push({ merchant: n.name, before: slug(n.before)!, after: slug(now) });
      continue;
    }
    for (const id of n.lineIds) {
      if (insOverride.run(id, n.before).changes > 0) {
        report.lineOverrides.push({ statement_line_id: id, merchant: n.name, category: slug(n.before)! });
      }
    }
  }

  // Rules nothing reaches any more go; a specific rule follows its vendor's new key.
  const reached = new Set(names.flatMap((n) => vendorRuleKeyCandidates(n.name, after)));
  const delRule = dbi.prepare(`DELETE FROM expense_category_rules WHERE id = ?`);
  const moveSpecific = dbi.prepare(
    `INSERT OR IGNORE INTO expense_category_rules (vendor, link_kind, link_key, category_id) VALUES (?, ?, ?, ?)`
  );
  for (const r of liveRules) {
    if (reached.has(r.vendor)) continue;
    if (r.link_kind !== "") {
      const to = vendorRuleKey(r.vendor, after);
      if (to && to !== r.vendor) {
        moveSpecific.run(to, r.link_kind, r.link_key, r.category_id);
        report.specificMoved.push({ from: r.vendor, to, link_kind: r.link_kind, link_key: r.link_key });
      } else continue;
    }
    delRule.run(r.id);
    report.rulesRemoved.push({ vendor: r.vendor, link_kind: r.link_kind, link_key: r.link_key, category: slug(r.category_id)! });
  }
  return report;
}

/** The report as lines a person reads (the migration's log, the loader's output). */
export function describeVendorCatalogChange(r: VendorCatalogChangeReport): string[] {
  const out: string[] = [];
  for (const a of r.rulesFromAdditionalCard) {
    out.push(`  rule - ${a.vendor} (${a.category}): only the additional card's ${a.lines} line${a.lines === 1 ? "" : "s"} reached it`);
  }
  for (const a of r.rulesAdded) out.push(`  rule + ${a.vendor} → ${a.category} (from ${a.from.join(", ")})`);
  for (const m of r.specificMoved) out.push(`  rule ~ ${m.from} → ${m.to} (${m.link_kind} ${m.link_key})`);
  for (const d of r.rulesRemoved) out.push(`  rule - ${d.vendor}${d.link_kind ? ` (${d.link_kind} ${d.link_key})` : ""} (${d.category})`);
  const kept = new Map<string, { category: string; n: number }>();
  for (const o of r.lineOverrides) {
    const k = `${o.merchant}|${o.category}`;
    kept.set(k, { category: o.category, n: (kept.get(k)?.n ?? 0) + 1 });
  }
  for (const [k, v] of kept) out.push(`  keeps own category: ${k.split("|")[0]} → ${v.category} (${v.n} line${v.n === 1 ? "" : "s"})`);
  for (const n of r.newlyCategorized) out.push(`  now categorized: ${n.merchant} → ${n.category} (${n.lines} line${n.lines === 1 ? "" : "s"})`);
  for (const u of r.unkept) out.push(`  CHANGES (no card line to keep it on): ${u.merchant} ${u.before} → ${u.after ?? "none"}`);
  return out;
}
