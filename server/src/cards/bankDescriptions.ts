/**
 * The bank's checking descriptions, read by rule (docs/untangle-plan.md F10): the patterns, the
 * unions the checking matchers ask about (own transfers, card payments, investment wires,
 * exclusions) and the DAP refund bounds are data (`bankDescriptionRules.ts`). The owner's own
 * transfers name the owner: the name patterns are the `owner_identity` table (migration 277),
 * read once per database state, never a literal in code — with no row they match nothing.
 */
import { db } from "../db.js";
import { dbStateMemo } from "../dbStateMemo.js";
import { BANK_DESCRIPTION_RULES, OWNER_PLACEHOLDER, fixedBankDescriptionPattern } from "./bankDescriptionRules.js";

/** Never matches (an owner pattern with no owner on record). */
const NEVER = /(?!)/;

export type OwnerIdentityKind = "name_pattern" | "rut";

/** The owner's identities of one kind (`owner_identity`). */
export function ownerIdentities(kind: OwnerIdentityKind): string[] {
  return dbStateMemo("owner_identity", kind, () =>
    (db.prepare(`SELECT value FROM owner_identity WHERE kind = ? ORDER BY id`).all(kind) as { value: string }[]).map(
      (r) => r.value
    )
  );
}

function ownerPattern(source: string): RegExp {
  const names = ownerIdentities("name_pattern");
  if (names.length === 0) return NEVER;
  return new RegExp(source.split(OWNER_PLACEHOLDER).join(`(?:${names.join("|")})`), "i");
}

let ownerCache: { key: string; byName: Map<string, RegExp> } | null = null;

/** A named pattern of the rule file (the owner's patterns filled from `owner_identity`). */
export function bankDescriptionPattern(name: string): RegExp {
  const source = BANK_DESCRIPTION_RULES.patterns[name];
  if (source == null) throw new Error(`bank description rules: no pattern ${name}`);
  if (!source.includes(OWNER_PLACEHOLDER)) return fixedBankDescriptionPattern(name);
  const key = ownerIdentities("name_pattern").join("\u0000");
  if (!ownerCache || ownerCache.key !== key) ownerCache = { key, byName: new Map() };
  let re = ownerCache.byName.get(name);
  if (!re) {
    re = ownerPattern(source);
    ownerCache.byName.set(name, re);
  }
  return re;
}

/** Whether any pattern of a named union matches the description. */
export function bankDescriptionMatchesUnion(union: string, description: string): boolean {
  const names = BANK_DESCRIPTION_RULES.unions[union];
  if (!names) throw new Error(`bank description rules: no union ${union}`);
  return names.some((n) => bankDescriptionPattern(n).test(description));
}
