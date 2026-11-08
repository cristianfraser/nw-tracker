/**
 * The bank's checking description rules as data (`server/contracts/data/bankDescriptionRules.json`),
 * compiled once; no database (the card-line and payment predicates import it). The patterns that
 * name the owner are filled from `owner_identity` by `bankDescriptions.ts`.
 */
import fs from "node:fs";
import { BANK_DESCRIPTION_RULES_PATH } from "nw-tracker-contracts";

type RulesFile = {
  patterns: Record<string, string>;
  unions: Record<string, string[]>;
  dap_abono: { max_day_gap: number; min_premium_ratio: number; max_premium_ratio: number; doc_spread: number };
  splittable_deposit_kinds: string[];
};

/** Where a pattern takes the owner's name patterns (`owner_identity`). */
export const OWNER_PLACEHOLDER = "{owner}";

function loadRules(): RulesFile {
  const raw = JSON.parse(fs.readFileSync(BANK_DESCRIPTION_RULES_PATH, "utf-8")) as Partial<RulesFile>;
  const { patterns, unions, dap_abono, splittable_deposit_kinds } = raw;
  if (!patterns || !unions || !dap_abono || !Array.isArray(splittable_deposit_kinds)) {
    throw new Error(`${BANK_DESCRIPTION_RULES_PATH}: patterns, unions, dap_abono and splittable_deposit_kinds are required`);
  }
  for (const [union, names] of Object.entries(unions)) {
    for (const n of names) {
      if (!(n in patterns)) throw new Error(`${BANK_DESCRIPTION_RULES_PATH}: union ${union} names unknown pattern ${n}`);
    }
  }
  for (const k of ["max_day_gap", "min_premium_ratio", "max_premium_ratio", "doc_spread"] as const) {
    if (typeof dap_abono[k] !== "number") throw new Error(`${BANK_DESCRIPTION_RULES_PATH}: dap_abono.${k} must be a number`);
  }
  return { patterns, unions, dap_abono, splittable_deposit_kinds };
}

export const BANK_DESCRIPTION_RULES = loadRules();

const compiled = new Map<string, RegExp>();
for (const [name, source] of Object.entries(BANK_DESCRIPTION_RULES.patterns)) {
  if (!source.includes(OWNER_PLACEHOLDER)) compiled.set(name, new RegExp(source, "i"));
}


/** A named pattern that does not name the owner; throws for an unknown or owner pattern. */
export function fixedBankDescriptionPattern(name: string): RegExp {
  const re = compiled.get(name);
  if (!re) {
    throw new Error(
      name in BANK_DESCRIPTION_RULES.patterns
        ? `bank description rules: ${name} names the owner (read it through bankDescriptions.ts)`
        : `bank description rules: no pattern ${name}`
    );
  }
  return re;
}

/** The DAP refund bounds (see the rule file). */
export const DAP_ABONO_RULES = BANK_DESCRIPTION_RULES.dap_abono;

/** Deposit kinds a lump-sum deposit of which several checking wires may split against. */
export const SPLITTABLE_DEPOSIT_KINDS: ReadonlySet<string> = new Set(BANK_DESCRIPTION_RULES.splittable_deposit_kinds);
