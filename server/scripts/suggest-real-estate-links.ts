/**
 * Report-first bulk linker for real-estate bills (purchase-first).
 *
 * For every tracked place (expense_accounts under the real_estate group), scans unlinked
 * gastos purchases in the 'bills' category within the place's occupancy period and
 * classifies them by merchant pattern → bill kind (global utility patterns + the place's
 * comunidad patterns). Rent detection is opt-in per place via --rent rules below.
 *
 * Never touches mortgage cash flows (MUTUARIA / METLIFE / TOKU) — the expenses page
 * derives the mortgage from the depto ledger.
 *
 * Usage:
 *   npx tsx scripts/suggest-real-estate-links.ts            # report only
 *   npx tsx scripts/suggest-real-estate-links.ts --apply    # apply the auto-classified rows
 */
import {
  listRealEstatePlaces,
  listRealEstateUnlinkedPurchases,
  type RealEstateUnlinkedPurchaseDto,
} from "../src/flowsRealEstateExpenses.js";
import { assignPurchaseToRealEstateExpense } from "../src/realEstateExpenseMatching.js";
import {
  merchantMatchesExpectation,
  REAL_ESTATE_LINKABLE_KINDS,
} from "../src/realEstateExpenseMerchants.js";

const APPLY = process.argv.includes("--apply");

/** Merchants that are mortgage cash flows — never suggested (ledger rows carry the cost). */
const MORTGAGE_CASH_PATTERNS = ["MUTUARIA", "METLIFE", "TOKU"];

/**
 * Per-place rent rules: merchant substring + exact amounts auto-apply; same-merchant
 * rows with other amounts are listed for manual review.
 */
const RENT_RULES: Record<string, { merchant: string; exactAmounts: number[] }> = {
  el_vergel: { merchant: "INMOBILIARIA", exactAmounts: [600000] },
  lastarria: { merchant: "Transf. Internet a otro Banco", exactAmounts: [555000] },
};

const KIND_ORDER = REAL_ESTATE_LINKABLE_KINDS.filter((k) => k !== "rent");

/**
 * Pre-cartola months exist as synthetic gap-filler lines whose merchant text ends in an
 * explicit kind tag: `synthetic:excel-gap|YYYY-MM|bills|<tag>`. The tag is the evidence.
 */
const SYNTHETIC_TAG_KINDS: Record<string, string> = {
  enel: "electricidad",
  vtr: "internet",
  rent: "rent",
  gastos_comunes: "gastos_comunes",
  aguas_andinas: "water",
};

function syntheticKind(p: RealEstateUnlinkedPurchaseDto): string | null {
  const m = p.merchant ?? "";
  if (!m.startsWith("synthetic:excel-gap|")) return null;
  const tag = m.split("|").at(-1) ?? "";
  return SYNTHETIC_TAG_KINDS[tag] ?? null;
}

function isMortgageCash(p: RealEstateUnlinkedPurchaseDto): boolean {
  const m = (p.merchant ?? "").toUpperCase();
  return MORTGAGE_CASH_PATTERNS.some((pat) => m.includes(pat));
}

function fmt(p: RealEstateUnlinkedPurchaseDto): string {
  return `${p.purchase_on ?? p.purchase_month}  ${String(Math.round(p.amount_clp)).padStart(9)}  ${p.merchant ?? "?"}  [${p.origin_label} ${p.source}]`;
}

let applied = 0;
/** Claims are global: era tails overlap (bill+2 window), a purchase belongs to one place. */
const claimed = new Set<string>();

function propose(place: string, kind: string, rows: RealEstateUnlinkedPurchaseDto[], apply: boolean) {
  if (rows.length === 0) return;
  const total = rows.reduce((s, r) => s + r.amount_clp, 0);
  console.log(`\n  ${kind} — ${rows.length} purchase(s), sum ${Math.round(total).toLocaleString("en-US")}${apply ? "" : "  [REVIEW ONLY]"}`);
  for (const r of rows.sort((a, b) => (a.purchase_on ?? "").localeCompare(b.purchase_on ?? ""))) {
    console.log(`    ${fmt(r)}`);
  }
  if (apply && APPLY) {
    for (const r of rows) {
      assignPurchaseToRealEstateExpense({
        purchaseKey: r.purchase_key,
        accountSlug: place,
        kind,
      });
      applied += 1;
    }
  }
}

for (const place of listRealEstatePlaces()) {
  // Cuota-split purchases emit one line per cuota month sharing the purchase_key —
  // a purchase is assignable once, so keep only the earliest line per key.
  const byKey = new Map<string, RealEstateUnlinkedPurchaseDto>();
  for (const p of listRealEstateUnlinkedPurchases({
    placeSlug: place.slug,
    category: "bills",
    limit: 1000,
  })) {
    if (isMortgageCash(p)) continue;
    const prev = byKey.get(p.purchase_key);
    if (!prev || (p.purchase_on ?? "") < (prev.purchase_on ?? "")) byKey.set(p.purchase_key, p);
  }
  const pool = [...byKey.values()];

  console.log(`\n=== ${place.label} (${place.slug}) ${place.active_from ?? "?"} → ${place.active_to ?? "now"}: ${pool.length} unlinked bills-purchases in era`);

  // Synthetic gap-filler lines classify by their explicit tag.
  for (const kind of [...KIND_ORDER, "rent"]) {
    const rows = pool.filter((p) => !claimed.has(p.purchase_key) && syntheticKind(p) === kind);
    rows.forEach((r) => claimed.add(r.purchase_key));
    propose(place.slug, kind, rows, true);
  }

  // Utility kinds by merchant pattern (place comunidad patterns included for gastos_comunes).
  // Contribuciones are owner costs (only property-linked places) and are often paid in
  // cuotas whose fragments duplicate the imported full-amount expectations — review only.
  for (const kind of KIND_ORDER) {
    if (kind === "contribuciones" && place.property_account_id == null) continue;
    const autoApply = kind !== "contribuciones";
    const rows = pool.filter(
      (p) =>
        !claimed.has(p.purchase_key) &&
        merchantMatchesExpectation(place.comunidad_merchant_patterns, kind, p.merchant ?? "")
    );

    // Same-day same-amount duplicates (e.g. a charge appearing on two cards) go to review.
    const seen = new Map<string, RealEstateUnlinkedPurchaseDto>();
    const dups: RealEstateUnlinkedPurchaseDto[] = [];
    const clean: RealEstateUnlinkedPurchaseDto[] = [];
    for (const r of rows) {
      const key = `${r.purchase_on}|${Math.round(r.amount_clp)}`;
      if (seen.has(key)) {
        const prev = seen.get(key)!;
        if (!dups.includes(prev)) {
          dups.push(prev);
          clean.splice(clean.indexOf(prev), 1);
        }
        dups.push(r);
      } else {
        seen.set(key, r);
        clean.push(r);
      }
    }
    clean.forEach((r) => claimed.add(r.purchase_key));
    dups.forEach((r) => claimed.add(r.purchase_key));
    propose(place.slug, kind, clean, autoApply);
    if (dups.length > 0) {
      console.log(`\n  ${kind}: same-day same-amount duplicates — MANUAL REVIEW:`);
      for (const r of dups.sort((a, b) => (a.purchase_on ?? "").localeCompare(b.purchase_on ?? ""))) {
        console.log(`    ${fmt(r)}`);
      }
    }
  }

  // Rent rules: exact amounts auto, same-merchant rest → review list.
  const rentRule = RENT_RULES[place.slug];
  if (rentRule) {
    const rentPool = pool.filter(
      (p) => !claimed.has(p.purchase_key) && (p.merchant ?? "").toUpperCase().includes(rentRule.merchant.toUpperCase())
    );
    const exact = rentPool.filter((p) => rentRule.exactAmounts.includes(Math.round(p.amount_clp)));
    const review = rentPool.filter((p) => !rentRule.exactAmounts.includes(Math.round(p.amount_clp)));
    exact.forEach((r) => claimed.add(r.purchase_key));
    propose(place.slug, "rent", exact, true);
    if (review.length > 0) {
      review.forEach((r) => claimed.add(r.purchase_key));
      console.log(`\n  rent? same merchant, non-standard amount — MANUAL REVIEW:`);
      for (const r of review.sort((a, b) => (a.purchase_on ?? "").localeCompare(b.purchase_on ?? ""))) {
        console.log(`    ${fmt(r)}`);
      }
    }
  }

  const rest = pool.filter((p) => !claimed.has(p.purchase_key));
  if (rest.length > 0) {
    console.log(`\n  unmatched (left alone): ${rest.length}`);
    for (const r of rest.sort((a, b) => (a.purchase_on ?? "").localeCompare(b.purchase_on ?? "")).slice(0, 25)) {
      console.log(`    ${fmt(r)}`);
    }
    if (rest.length > 25) console.log(`    … and ${rest.length - 25} more`);
  }
}

console.log(APPLY ? `\nAPPLIED: ${applied} assignment(s).` : "\nDRY RUN — nothing written. Re-run with --apply.");
