# Vendor catalog: when a chain changes its name

The vendor catalog (`vendor_catalog`, `server/src/vendorCatalogMatch.ts`) has no dates: one entry names every line whose bank text it matches, past and future. This note says how to handle a chain that changes its name, so its history keeps the old name.

## The first case: OK Market became Oxxo (migration 325, 2026-11-12)

The chain's stores became Oxxo from 2022, and the bank kept printing them as before. The spellings split cleanly by date:

| Bank text | Lines | Shown |
|---|---|---|
| `OK MARKET <branch>` | 2017 → 2020 | OK Market (branch) |
| two `OKM <branch>` spellings | 2017 → 2018 | OK Market (branch), from the user's own catalog file (exact entries) |
| `OKM <branch>` | 2022 → | Oxxo (branch) |
| `MERPAGO*OK MARKET S.A.` | 2023 → 2024 | Oxxo |

So spellings alone did it: a seed `OKM` branch entry gives Oxxo, and exact entries give the two older `OKM` lines their old name.

## The rule for the next rebrand

1. List the bank's spellings for the chain with their first and last line date (`cc_statement_lines` by merchant).
2. If each spelling falls on one side of the change, name the spellings as in the table above: a branch or prefix entry for the side with more spellings, exact entries for the rest. Old entries for history are personal data, so they go in the user's file (`cfraser/vendor-catalog.json`, `server/scripts/load-vendor-catalog.ts`). Seed entries take generic brands only.
3. If a single spelling has lines on both sides of the change, entries cannot name it right. That is when the catalog needs dates: add `valid_from` / `valid_to` (ISO days, nullable) to `vendor_catalog`, let `match` take the line's date, and pass `purchase_on ?? occurred_on` from `expenseLineDisplayNames`. The category rule key (`vendorRuleKey`) must stay one per vendor in that case: give both names the same `brand`, or one rule will not reach the other's lines.
4. Whatever the change, write it through `applyVendorCatalogChange` (`server/src/vendorCatalogChange.ts`, used by migrations and the loader). It carries the category rules the new names move, and it keeps a line's category as its own when the merged brand's rule would change it. Read its report before applying.
