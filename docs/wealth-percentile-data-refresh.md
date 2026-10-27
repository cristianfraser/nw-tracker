# Wealth percentile — data refresh procedure

The `/wealth-percentile` page places each year-end net worth in a lognormal fitted to
published wealth-per-adult figures (`server/src/wealthDistributions.ts`). The data is a
committed TS table, so it only moves when someone refreshes it. **Do this once or twice a
year**: after the UBS Global Wealth Report (late June / early July) and, optionally, after
the World Inequality Database (WID) annual update (November / December). Each pass has
three jobs: (1) add the new year, (2) look for hard data for years that are still
interpolated (†) or reconstructed (‡), (3) correct older rows if a source restates them.

Last pass: **2026-10-21** (research by a web agent, verified against the PDF text layer).

## What the flags mean today

| Flag | Rows | Meaning | Retire when |
|---|---|---|---|
| `*` | years after the newest row | the page reuses the latest distribution | the new year's row lands |
| `†` `interpolated` | 2023, 2024 (all countries) | geometric interpolation between end-2022 (Databook 2023) and end-2025 (GWR 2026), because UBS changed its model in between | UBS prints a restated series that covers those years on the current basis |
| `‡` `reconstructed` | CL 2025 (median only), CN 2025 (mean + median) | own calibration from UBS's Gini and millionaire count | UBS prints the figure |

The UI shows the flags of the **Chile** row only (`reconstructed` / `interpolated` on
`WealthPercentileYearRow`); benchmark provenance lives in each record's `source` string.

## Sources and what each gives

### UBS Global Wealth Report (the anchor series)

- **Databook 2023** (end-2022 and earlier): the last edition with a full country table —
  mean, median, adults, financial / non-financial / debt per adult (Table 2-2), Gini
  (Table 3-1). Everything 2016–2022 comes from it. No later databook exists.
- **GWR 2024 / 2025 / 2026** (end-2023 / 2024 / 2025): report PDFs only, no appendix, no
  data download. Each prints a **top-25 (2026: top-30) mean and median table** — US, ES, CH,
  UK, AU, JP always; DE mean always, median only in 2026 — a **Gini table** (2024/2025: 32
  markets without Chile; 2026: all 56, Chile 0.71), the **UBS Millionaire Index** (counts
  per market) and a millionaire growth table. CL, MX, BR, CN never appear in the mean /
  median tables. No adult population per country.
- **Regional editions of GWR 2026** (Spanish Latin-America edition, p.7, running text): the
  only place UBS prints end-2025 levels for Latin America — Chile mean «supera ligeramente
  los 66.400 USD» (no median anywhere), Mexico «más de 75.000» / median «cerca de 14.500»,
  Brazil «cerca de 27.000» / 5.090. **Check the regional editions every year**; the English
  report only gives the regional range.
- **Comparability rule.** Every edition since 2024 states its figures are not comparable
  with the previous one (GWR 2026 p.8: «Some methodologies used for compiling and
  estimating data have been updated for this edition, hence comparisons with previous
  reports are not always possible»; p.38 says the same of the millionaire counts, «both
  current and historic data»; GWR 2025 p.43 likewise). The break is visible: US median
  124,041 (GWR 2025) → 68,998 (GWR 2026). **Never mix medians across editions.** A year's
  row takes its mean and median from ONE edition; between two editions on different bases,
  interpolate (what the 2023/2024 rows do) and flag it. The means of GWR 2024 / 2025 are
  within a few percent of the interpolated path and serve as a sanity check only.
- URLs (as of 2026-10): GWR 2026
  `https://www.ubs.com/content/dam/assets/wm/static/gwr/global-wealth-report-en-2026.pdf`;
  GWR 2024
  `https://www.ubs.com/content/dam/assets/wm/static/noindex/wm-germany/2024/doodownload/Global-Wealth-Report-2024.pdf`;
  GWR 2025 was unreachable on ubs.com (empty body), a mirror of UBS's
  `global-wealth-report-09072025.pdf` is on elements.visualcapitalist.com; the Latin-America
  edition is linked from `https://www.ubs.com/cl/es/wealthmanagement/insights/global-wealth-report.html`.
  Read them with `pdftotext -layout`; the tables are in the text layer.

### Alternatives (shape and trend, not drop-in levels)

- **WID.world** (`https://wid.world/bulk_download/WID_data_<CC>.csv`, semicolon CSV,
  25–55 MB per country): net personal wealth per adult `ahwealj992`, thresholds
  `thwealj992` (p50 / p90 / p99), shares `shwealj992`, adults `npopuli992`, in constant
  local currency (price index `inyixxi999`, fx `xlcusx999`). Covers every year through the
  previous calendar year (2024 as of the 2025 update, nothing for 2025), but the
  `data_quality` flag is 0 for every 2023/2024 wealth value in all 11 countries — model
  updates, not new survey / tax data. The concept differs from UBS (equal-split within
  couples, DINA totals): Chile 2022 median 12.4k vs UBS 19.5k, US 2022 mean 492k vs UBS
  551k. Useful to check a trend, never to replace a UBS level.
- **OECD Wealth Distribution Database** (SDMX
  `https://sdmx.oecd.org/public/rest/data/OECD.WISE.INE,DSD_WEALTH@DF_WEALTH,/all?format=csvfilewithlabels`):
  survey-based, per household, sparse years (CL 2021, US 2022, ES 2021, DE 2021, AU 2020,
  JP 2019, UK 2017; no MX / BR / CN). Nothing for 2023+.
- **Chile, Banco Central — Encuesta Financiera de Hogares**: waves 2017, 2021, **2024**
  (released 2025-09-30; household median net wealth 30,873,492 CLP, mean 87,592,584 CLP,
  per household, not per adult). The results document is at
  `https://www.bcentral.cl/documents/d/banco-central/documento-de-resultados-efh-2024`;
  bcentral.cl blocks automated fetches (Imperva), open it in a browser. The next wave is
  presumably 2027/28. **Cuentas Nacionales por Sector Institucional** (quarterly) give the
  household financial balance sheet only — no housing wealth, so no total net worth.

## Checklist for a pass

1. **Is there a new GWR?** Download the English PDF and every regional edition (Latin
   America at least). `pdftotext -layout` both. Find: the mean/median top-N table, the
   Gini table, the Millionaire Index, the millionaire growth table, the financial /
   non-financial / debt breakdown, and the regional text paragraphs with per-adult levels.
2. **Read the comparability statement** («The world that we analyze» and the methodology
   page near the end). If the edition claims comparability with the previous one, or
   prints a multi-year series per country, that series replaces the interpolation for the
   years it covers — remove `interpolated` on those rows and record the table reference.
   Otherwise the new year is a new anchor and the years between it and the previous anchor
   are interpolated; `interpolatedRecords()` in `wealthDistributions.ts` currently hardcodes
   the 2022→2025 pair, so **generalize it to a list of anchor pairs** before adding
   end-2026 (the 2025→2026 pair will be the second gap, or 2025 and 2026 may share a basis).
3. **Add the new year's rows** for the 11 countries: mean + median where printed; Gini from
   the Gini table (the fallback path when no median is printed, and provenance otherwise);
   adults extrapolated from Databook 2023 Table 2-2's 2016→2022 linear trend (no later
   source prints them); CL `mean_fin_usd` = mean × (fin share − debt share) / (1 − debt
   share) with the 2022 shares (0.58 / 0.16) unless UBS prints Chile in its breakdown
   table. `source` names the document, table / page and any rounding («más de 75.000»).
4. **Reconstruct what is still missing** the way the CL and CN rows were built: sigma from
   the Gini (`sigma = √2·phiInv((G+1)/2)`), mu from the millionaire share over adults, then
   median = e^mu, mean = e^(mu + sigma²/2). When the mean IS printed but the median is not
   (Chile), keep the printed mean and solve the median so the mean/median lognormal
   reproduces the millionaire count (bisection; see `wealthDistributions.test.ts`, «model
   validation»). The Chile count is not in the Millionaire Index table — infer it from the
   growth table (+2,593 at +3.9 % → ≈69,100 for end-2025). Flag the row `reconstructed`.
5. **Check the tail.** For each new row, compute the lognormal's millionaire count against
   the Millionaire Index. Brazil's printed mean/median land within 20 % of its count;
   Mexico's printed pair (75,000 / 14,500) implies ≈900k millionaires against UBS's 333k
   and an implied Gini of 0.80 against the published 0.72 — UBS's distribution is not a
   lognormal, and the module keeps the printed figures (preferred mean/median fit) and
   accepts the fatter tail. Note any such gap in the row comment; p99 for that country is
   less reliable than the module doc's general claim.
6. **Fix older rows** when a source restates them (a UBS erratum, a corrected regional
   edition). Older Databook 2023 rows are pinned by the test «keeps the verified end-2022
   anchors as-is»; change the test together with the row and record the reason.
7. **Run** `cd server && npm run test -- wealthDistributions wealthPercentile` and the
   root `npm run typecheck`. Update the `markers.*` i18n strings if a flag's meaning changes,
   the module doc header, this file's «Last pass» line, and the memory note.

## Open items after the 2026-10 pass

- `interpolatedRecords()` hardcodes 2022→2025; generalize before the end-2026 row.
- The page shows only Chile's flags; a per-country provenance marker on the benchmark
  columns would make MX/BR/CN's basis visible.
- Mexico 2025: printed mean/median vs Gini/millionaire count disagree under the lognormal
  (see step 5). A two-piece fit (lognormal body + Pareto tail from the millionaire count)
  would carry both; not built.
- Chile: compare the EFH 2024 household figures (converted to per adult) with the 2025 row
  once the BCCh document is read; WID's Chile median (13k) sits far below UBS's — understand
  why before leaning on WID for Chile.
