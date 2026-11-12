/**
 * A local Formulario 22 for one año tributario: the return as filed (`sii_f22_filed`), what third
 * parties informed (`sii_informed_dj`), and a draft in which the codes the app can state itself
 * REPLACE what was filed — the crypto gain (code 1032, or a loss added to the filed 169), foreign
 * dividends (1104 net, 748 the foreign tax as gross-up, 1018 its credit — línea 45 of the AT2026
 * form, the art. 41 A N°4 letra B) credit on a natural person's own foreign incomes; the SII's
 * observation G08 also names 746, but that is línea 49, the credit a Chilean company passes
 * through with its dividends, see `f22/foreignIncome.ts`), foreign share / ETF
 * sales (added to 1104, taxed under the régimen general) and the art. 107 instruments' sales
 * (recuadro N°4: 1809 / 1813 → 1816, línea 66: 1829 / 1830, `f22/art107`) — so a year that
 * already declared them (AT2022 filed 1032) shows the correction, not a double count; then it
 * recomputes the tax with the same chain the filed form shows:
 *
 *   158 = 1098 + 1030 + 110 + 105 + 955 + 155 + 152 + 1032 + 1104 + 748 + 1901 − 169   (lines 1–14 less line 17; 1030 = foreign salary; 110 = fees; 955 = rent)
 *   170 = 158 − 750 − 765                                  (mortgage interest art. 55 bis; APV art. 42 bis)
 *   157 = IGC table on 170, in UTA of December of the income year
 *   136 = 157 × 152 / 158                                  (exempt income, art. 56 N°2)
 *   304 = 157 − 136 − 1637 − 162 − 1018 − 610 − 746        (1637: contribuciones on rented property; 162: IUSC withheld; 610: IDPC credit; 746: a Chilean company's pass-through art. 41 A credit, línea 49, never drafted)
 *   305 = 304 + 1830 − 198 + 900                           (1830: art. 107's 10% impuesto único, outside IGC)
 *
 * Fees (art. 42 N°2, línea 2) come from the boletas de honorarios issued (`sii_issued_fee_receipts`)
 * for a year with no filed form: the fees box's gross (547), its presumed expenses (494: 30 % of
 * the gross, at most 15 UTA), the net (110 = 547 − 494, less an APV régimen B deposit declared in
 * the box as 770 when no employer reported the year) and the retention as a credit (198). The
 * pension contributions the SII charges on fees (900) are not drafted: their rates (SIS, accident
 * insurance, the coverage ramp) are not on file; a filed form carries them.
 *
 * Mortgage interest (art. 55 bis) is the interest paid (751: the lender's DJ 1898, else the ledger
 * estimate) and its deduction (750: at most 8 UTA, reduced between 90 and 150 UTA of gross income).
 *
 * Rents (`f22/rentals`): a non-DFL-2 place's rent is línea 5 letra a), code 1849 → 955 (art. 20 N°1
 * b)), its contribuciones the línea-39 credit 1637; a DFL-2 place's rent is not declared (shown).
 *
 * Real interest (DJ 1890) is the exempt income of línea 9 (152, art. 57 / art. 54 N°3): positive
 * less negative, and a net negative goes to line 17 (169) as the Suplemento instructs for
 * «resultados negativos … registrados en la línea 17» — never a negative 152, which made 136
 * negative and raised 304.
 *
 * 105 is a domestic dividend afecto al IGC (línea 2): an art. 107 fund's distributions, from DJ
 * 1922 when the custodian reported them, else estimated from the cash credited.
 *
 * The chain must reproduce the filed 304 from the filed codes alone, or the draft throws — that is
 * what makes its additions trustworthy. Foreign share gains also bear first-category tax (line 58,
 * IDPC 25%) credited back against IGC with refund (code 1914), so they change 304 only through
 * IGC; the draft reports the IDPC lines beside it. The exchange result on the dollars bought with
 * pesos (`f22/foreignFx`) takes the same path under its default route: art. 20 N°5 income in line
 * 58 d), code 1901, with IDPC at {@link IDPC_RATE} credited back in line 5 (`foreignFxIdpcClp`,
 * reported beside, net zero), so it changes 304 only through 158; a loss on that route offsets
 * nothing here and is reported. The alternative route adds it to 1032 and a loss to 169 like the
 * crypto result ({@link FOREIGN_FX_DEFAULT_ROUTE}). Report-only: `estimatedCodes` carries its codes.
 *
 * Losses (code 169) are deducted only from the gains of line 17's codes ({@link CAPITAL_LOSS_POOL_CODES}),
 * never from salary, and only in their own year; the draft caps 169 at that pool and reports what
 * is left on either side ({@link F22LossOffset}). A foreign share loss is not a 169 loss: 169
 * takes only losses of art. 20 N°2 and art. 17 N°8 operations (SII Suplemento Tributario, line
 * «Pérdida en operaciones de capitales mobiliarios», letter B), and art. 41 B excludes foreign
 * investments from art. 17 N°8. It nets only against the year's other foreign share gains, and a
 * negative total is declared as zero (as Fintual and Racional instruct); {@link F22OffsetBalance}.
 *
 * **Residency (2026-11-10; `taxResidency.ts`, docs/demo-app-features-plan.md §1).** The regime of an
 * income year follows the DECLARED tax residency, never an inference: `resident` (the whole year,
 * everything above), `nonresident` (no day of it; the Impuesto Adicional) or `split` (the departure
 * year: Chile through the declared day, the US after). Readings, each quoted in `taxResidency.ts`'s
 * or this header, the sources read 2026-11-10:
 *
 * - **A non-resident declares Chilean-source income only** (LIR art. 3) under the **Impuesto
 *   Adicional of art. 60 inc. 1 at 35 %** — the rent of a non-DFL-2 apartment is art. 20 N°1 b)
 *   income no payer withholds — on **línea 72 of the AT2026 F22, «IA según arts. 58 N° 1 y 2 y 60
 *   inc. 1° LIR»** (Instrucciones 72.2: «Al código 32 se debe trasladar la cantidad positiva
 *   registrada en el código 158 de la línea 19 del F-22 (SUB TOTAL), que constituye la base
 *   imponible del IA»; «El monto del IA … se determina aplicando sobre la cantidad registrada en el
 *   código 32, la tasa de 35%»; code 76 the credits — IDPC, ex-art. 21, IPE of art. 41 A —, code 34
 *   the tax less them; «las partidas (rentas y deducciones) que conforman la base imponible del IA …
 *   deben detallarse previamente en las líneas que correspondan de las secciones "Rentas brutas
 *   afectas" o "Rebajas a la renta"»). So the rent still goes through 1849 → 955 → 158, and 158 is
 *   the base: the rebajas of líneas 20–23 (750 / 765, IGC deductions of arts. 55 bis and 42 bis)
 *   never reach code 32, and the IGC credits (1637, línea 39; 136; 162) have no IGC to credit. The
 *   chain: 32 = max(0, 158), 34 = max(0, round(35 % × 32) − 76), 305 = 304 + 34 + 952 + 1830 − 198 −
 *   833 + 900 (`f22/identities.ts`). A non-resident's DFL-2 rent is exempt too: DFL N° 2 art. 15,
 *   «Las rentas que produzcan las "viviendas económicas" no se considerarán para los efectos del
 *   Impuesto Global Complementario ni Adicional» (the plan's doubt resolved by the text).
 * - **What does not enter, and why — kept in the payload as {@link F22ExcludedItem}s, never silently
 *   gone:** the US salary, foreign dividends, foreign interest, foreign share gains and the dollar
 *   lots' exchange result are foreign-source (`nonresident`, art. 3); the crypto gain at a Chilean
 *   exchange would be art. 20 N°5 income at 35 % under art. 60 inc. 1 by domestic law (the SII's
 *   position on a non-resident's digital assets was NOT found: UNVERIFIED), but the Chile–US
 *   convention art. 13(8) — «Gains from the alienation of any property other than property referred
 *   to in paragraphs 1 through 7 shall be taxable only in the Contracting State of which the
 *   alienator is a resident» — leaves it to the US (`treaty_art13_8`); a Chilean fund's redemption
 *   gain and distributions bear Ley 20.712 art. 82 letra B)'s 10 % impuesto único, withheld by the
 *   administradora (i: «estará afecta a un impuesto único a la renta del 10%»; ii: «el mayor valor
 *   obtenido estará también afecto al impuesto único del literal i) anterior … será retenido por la
 *   sociedad administradora», 5 % provisional on the price until the gain is known; F22 línea 69,
 *   951 / 952, only when the gain «no se pueda determinar en forma definitiva», the retention
 *   credited in 833) — whether art. 13(8) of the convention reaches fund cuotas (a fund is no
 *   «company» of 13(5)) is UNVERIFIED, so the item is shown withheld, not declared
 *   (`fund_unico_withheld`); Chilean bank interest is withheld by the payer (art. 59 N°1 — 4 % on
 *   deposits of letter a) and, through letter g), «emitidos o expresados en moneda nacional» —,
 *   art. 74 N°4; convention art. 11(2) caps it at 10 %), never in the annual return
 *   (`withheld_at_source`); the residents' deductions and credits 750 / 751, 765, 1637 go
 *   (`no_igc`). A Chilean salary or boleta after the departure (art. 60 inc. 2, 20 %) throws: not
 *   modelled.
 * - **Art. 107 for a non-resident is the same 10 % único, not an ingreso no renta** (the plan's
 *   reading corrected from the text): N°6 «El adquirente o corredor de bolsa o agente de valores que
 *   actúa por cuenta del vendedor sin domicilio ni residencia en Chile deberá retener el monto del
 *   impuesto único al momento en que el precio de enajenación sea pagado» (10 %, or 1 % provisional
 *   on the price) and the seller «quedará liberado de presentar la referida declaración anual» only
 *   when the retention covers the tax; N°7 «los contribuyentes sin domicilio ni residencia en Chile
 *   … deberán considerar el valor de adquisición y/o aporte conforme a la letra b) anterior» (the
 *   general-rule cost; the Dec-31 close is the residents' option). The draft keeps línea 66 with
 *   `costChoice: "cost_paid"` and no retention record (833 is never drafted).
 * - **The departure year is two parts** (`split`): the resident part is this module's computation
 *   restricted to the items dated through the declared day (every loader takes a {@link DateWindow};
 *   a yearly DJ figure — 1887, 1890, 1894, 1899 — cannot be split and stays whole in the resident
 *   part, except the lender's DJ 1898, replaced by the ledger's interest paid through the day), the
 *   non-resident part the Impuesto Adicional on the Chilean-source items after it. One form cannot
 *   carry two bases, so the combined codes are the resident part's plus 32 / 34 from the non-resident
 *   part (its 1849 / 955 / 158 stay in `nonresident.codes`), art. 107 summed with one carry, and
 *   305 over both. LIR art. 103's departure return — «declarar y pagar la parte del impuesto
 *   devengado … antes de ausentarse del país», the arts. 56 N°1–2 credits and the UTA of arts. 52
 *   and 57 «en forma proporcional» — is noted, not built: the resident part uses the full-year
 *   table.
 *
 * **Layout (2026-11-10, docs/demo-app-features-plan.md §5 item 15).** This module composes; each
 * part is its own module under `f22/`: the chain and the code-169 pool (`chain.ts`), what the SII's
 * documents state (`sources.ts`), the window's items (`blocks.ts`, over the income blocks `salary.ts`,
 * `fees.ts`, `rentals.ts`, `art107.ts`, `crypto.ts`, `foreignShares.ts`, `foreignIncome.ts`,
 * `dividends.ts`, `foreignFx.ts`, `estimates.ts`), the regimes (`resident.ts`, `nonresident.ts`), the
 * offsets (`offsets.ts`) and the types (`types.ts`). The blocks read the jurisdiction-neutral tax
 * facts (`taxFacts/`) and apply the Chilean rule: which enter, at which rate and reajuste, into
 * which code.
 */
import { chileWallClockNow } from "../chileDate.js";
import { assertReadsEarlierReturn } from "../taxReturnOrder.js";
import { buildF1040Draft, usReturnStatusForYear } from "../us1040/draft.js";
import { filedF1040 } from "../us1040/filed.js";
import { informedDjAmount } from "../siiInformedDj.js";
import { loadWindowBlocks } from "./blocks.js";
import type { F22UsTaxRead } from "./foreignIncome.js";
import { f22Code305 } from "./identities.js";
import { EMPTY_OFFSET } from "./offsets.js";
import { residentPart } from "./resident.js";
import { DJ1922_ART107_DIFFERENCE } from "./sources.js";
import type { F22Codes, F22Draft, F22DraftBase, F22DraftOptions } from "./types.js";
import { f22NonresidentPartOf, f22Year } from "./year.js";

export { FOREIGN_FX_DEFAULT_PURCHASE_COST, FOREIGN_FX_DEFAULT_POSTURE, FOREIGN_FX_DEFAULT_ROUTE } from "./year.js";

const zeroToNull = (n: number): number | null => (n === 0 ? null : n);

/**
 * The year's US income tax as a resident window of the F22 credits it (the 1040's line 24): the
 * filed return when stored, else the draft — and, for a nonresident alien of the US (no 1040 drafted:
 * a Form 1040-NR), an explicit «not drafted» with no credit until the filed return is stored. Only a
 * year whose 1040 comes first (`taxReturnOrder`) may be read.
 */
export function f1040TaxForF22(incomeYear: number, todayYmd: string): F22UsTaxRead {
  assertReadsEarlierReturn("f22", "f1040", incomeYear);
  const filed = filedF1040(incomeYear);
  if (filed) return { usd: filed.lines["24"] ?? 0, source: "filed" };
  if (!usReturnStatusForYear(incomeYear).drafted) return { usd: 0, source: "nonresident_alien_not_drafted" };
  return { usd: buildF1040Draft(incomeYear, todayYmd).lines["24"] ?? 0, source: "draft" };
}

export function buildF22Draft(
  taxYear: number,
  todayYmd: string = chileWallClockNow().ymd,
  options: F22DraftOptions = {}
): F22Draft {
  const y = f22Year(taxYear, todayYmd, options, (incomeYear) => f1040TaxForF22(incomeYear, todayYmd));
  const { incomeYear, regime, residentWindow, residency, provisional, utaClp, utaProvisional, filed, dj, informed, yearEndObservado } = y;

  const nr = f22NonresidentPartOf(y);
  const nonresident = nr?.part ?? null;

  // The display blocks: the resident window's when there is one, else the non-resident year's own.
  const blocks = residentWindow ? loadWindowBlocks(y.ctx, residentWindow, false) : nr!.blocks;
  const { salary, crypto, dividends, foreignShares, art107, art107Distributions, foreignFx, rentals, foreignSalary, foreignInterest } = blocks;
  const art107DistributionsClp = Math.round(art107Distributions.reduce((s, x) => s + x.amountClp, 0));
  const f1964 = dj.get(1964);
  const f1891 = dj.get(1891);
  const f1922 = dj.get(1922);
  const common = {
    taxYear,
    incomeYear,
    provisional,
    regime,
    residency,
    nonresident,
    excluded: nonresident?.excluded ?? [],
    utaClp,
    utaProvisional,
    yearEndObservado,
    filed,
    salary,
    informed,
    crypto,
    cryptoInformedSalesClp: f1964 ? informedDjAmount(f1964, "MONTO", "A") : null,
    dividends,
    foreignShares,
    art107,
    art107Distributions,
    art107DistributionsClp,
    // A zero a third party reports says nothing (no sales, no difference): null, like informedCodes.
    art107InformedSalesClp: f1891 ? zeroToNull(informedDjAmount(f1891, "Monto Total Ventas")) : null,
    art107InformedResultClp: f1922 ? zeroToNull(informedDjAmount(f1922, DJ1922_ART107_DIFFERENCE)) : null,
    foreignFx,
    rentals,
    foreignSalary,
    foreignInterest,
  };

  if (!residentWindow) {
    // A non-resident year: the Impuesto Adicional part is the whole return.
    const part = nonresident!;
    const base: F22DraftBase = filed ? "filed" : Object.keys(informed).length > 0 ? "informed" : "none";
    const draft: F22Codes = { ...part.codes };
    if (part.taxComputed) {
      // No IGC: 304 is 0 on the form, and 305 is the Impuesto Adicional plus the únicos.
      draft[304] = 0;
      draft[305] = f22Code305(draft);
    }
    return {
      ...common,
      base,
      taxComputed: part.taxComputed,
      fees: null,
      draft,
      foreignSharesIdpcClp: 0,
      estimatedCodes: [],
      lossOffset: { ...EMPTY_OFFSET, parts: [] },
      foreignShareOffset: EMPTY_OFFSET,
      foreignFxIdpcClp: 0,
      propertyTaxCredit: null,
      foreignSalaryCredit: null,
    };
  }

  // The resident part: the computation this module always made, over the resident window's items.
  return {
    ...common,
    ...residentPart({
      taxYear,
      incomeYear,
      split: regime === "split",
      residentWindow,
      blocks,
      filed,
      dj,
      informed,
      utaClp,
      yearEndObservado,
      art107DistributionsClp,
      nonresident,
    }),
  };
}
