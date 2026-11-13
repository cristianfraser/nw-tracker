/**
 * Card issuers: a card master's issuer is `credit_card_account_config.issuer` (one of these slugs;
 * its `accounts.import_key`, `credit_card_master|<slug>|<last4>`, is the card's identity only). An
 * issuer carries the rules a statement does not state; its `sort_order` orders the cards under
 * Pasivos › tarjeta de crédito. A leaf module.
 */
/**
 * How an issuer sets a facturación's PAGAR HASTA when no statement has printed it yet (an open,
 * provisional or projected month) — backtracked over every statement on file (2026-10-26):
 * BCI prints the 10th of the month after the close as it falls, weekends included (14 of 14);
 * Santander lands on the 8th–10th with no exact rule from the close, and «the 10th, moved back
 * to the previous Chile business day» is the closest (16 of 23 on the current card, the other
 * seven one day earlier than predicted, never later); CMR printed close + 16 days (the 30th);
 * the fictional US issuer (Lonestar) close + 25 days, the US norm (CARD Act: at least 21 days
 * between the statement mailing and the due date).
 */
export type CcDerivedPayByRule =
  | { kind: "next_month_day"; day: number; prior_business_day: boolean }
  | { kind: "close_plus_days"; days: number };

/**
 * How the issuer's web table signs an amount (the bank's own listing, pasted or fetched):
 * Santander shows charges negative and payments / refunds positive, BCI the other way round. The
 * CMR card's statements print charges positive; its web table was never pasted, so it takes that
 * convention (2026-11-08: a CMR paste used to throw for want of a rule). The US issuer (Lonestar)
 * has no web-paste source at all (its documents are statements only); its group and sign exist so
 * the issuer row is complete and a stray paste reads like any charges-positive card.
 */
export type CcWebPasteSign = "charges_negative" | "charges_positive";

/**
 * When cuota 1 of a purchase in cuotas bills, per the bank's type for it (`CcCuotaPurchaseKind`):
 * at the close of the purchase's own cycle, or at the next one. Santander: «CUOTA COMERCIO» at the
 * next close (10 of 10 on the 2026 statements), «N/CUOTAS PRECIO CONTADO» in the purchase cycle
 * (9 of 9); BCI bills «cuota comercio» in the purchase cycle (4 of 4). CMR: no plan on record —
 * the purchase cycle, the manual default.
 */
export type CcFirstCuotaTiming = "purchase_cycle" | "next_cycle";

/**
 * The currencies an issuer's statements are printed in (lowercase ISO codes): the `primary` is the
 * one every facturación prints (a facturación closes on its statement); the `secondary` ones are
 * printed only in cycles with activity in them (a Chilean card's dollar statement), so a month
 * waits for one only while the imported stream carries it (`requiredStatementCurrenciesForAccount`).
 */
export type CcStatementCurrencies = { primary: string; secondary: readonly string[] };

/** The import batch kinds a fetched listing is logged under (a subset of `ImportBatchKind`). */
export type CcListingFeedBatchKind = "cc_santander_fetch" | "cc_lider_fetch";

/**
 * How the issuer splits a plan's principal into cuotas it has not printed yet (a printed cuota
 * always keeps its printed amount): every cuota the principal ÷ N rounded down
 * (`floor_last_absorbs`) or half up (`round_half_up_last_absorbs`), the last cuota taking what is
 * left. Santander rounds half up — 30 of its 32 finished plans on 2026-11-12 (120.006 in 12 would bill
 * 11 × 10.001 + 9.995); the default for an issuer not checked is floor.
 */
export type CcCuotaSplit = "floor_last_absorbs" | "round_half_up_last_absorbs";

type CcIssuerDef = {
  slug: string;
  /** The card's short brand as a payment line names it («Pago Lider ·0101»). */
  display_brand: string;
  sort_order: number;
  statement_currencies: CcStatementCurrencies;
  /** The issuer offers cuota products: a card of an issuer without them has its statements as the whole evidence. */
  installments: boolean;
  cuota_split: CcCuotaSplit;
  /**
   * A feed or a web paste lists the open cycle before its statement closes (Santander, BCI); an
   * issuer without one shows nothing of the current cycle until its statement.
   */
  unbilled_listing: boolean;
  /**
   * The issuer's fetched unbilled listing (`card.unbilled_movements`): how it names a card —
   * Santander by its contract number (mapped through `cfraser/organize-identifiers.json`), BCI by
   * the plastic's last4 (its site shows no contract number) — and the import batch kind its lines
   * are logged under. Null for an issuer no feeder reads.
   */
  listing_feed: { names_card_by: "contract_number" | "card_last4"; batch_kind: CcListingFeedBatchKind } | null;
  derived_pay_by: CcDerivedPayByRule;
  /** The bucket card_group a pasted or fed line is stored under, and how its web table signs it. */
  web_paste: { card_group: string; sign: CcWebPasteSign };
  /**
   * Days from a close to the next cycle's first day, when no statement of the card prints the
   * next period (`closeDayOffsetDays` reads it from the latest one that does): Santander starts
   * the next cycle ON the close day (a purchase dated the close day bills next month), BCI the day
   * after. CMR printed none; the day after.
   */
  close_day_offset_days: number;
  first_cuota: { cuota_comercio: CcFirstCuotaTiming; precio_contado: CcFirstCuotaTiming };
  /**
   * The statement parser's layouts that only this issuer prints (prefix): how a parsed statement
   * names its issuer before it has an account (`ccIssuerForParserLayout`).
   */
  parser_layout_prefixes: readonly string[];
  /**
   * The import-time reconcile's band for «Monto total facturado» against the parsed lines, as a
   * share of the printed total (`ccStatementImportReconcile.ts`): BCI's identity is exact
   * (operaciones + cargos), Santander's legacy layouts round.
   */
  monto_facturado_tolerance_pct: number;
  /**
   * The merchant renderings the issuer adds that cross-source matching strips: BCI's statement
   * appends « (T)» and its web table «,CITY».
   */
  merchant_suffixes: "bci_terminal_and_city" | null;
  /**
   * Where the issuer's card is paid with another card in one charge, as that charge's merchant
   * opens (folded, upper case): the facturado-financing matcher (`ccFacturadoFinancingAuto.ts`)
   * takes a one-shot charge on another card as this card's payment only when it opens like one of
   * these and equals a closed facturado to the peso. BCI Lider is paid at a Lider store's counter:
   * «RECAUDACION EX PLAZA LYON» on the statement, «EXPRESS PLAZA L…» in the feed (2026-07-30,
   * 2026-11-09); the Lider store names are the vendor catalog's Lider brands. None for the others.
   */
  facturado_paid_at_merchant_prefixes: readonly string[];
};

export const CC_ISSUERS = [
  {
    slug: "santander",
    display_brand: "Santander",
    statement_currencies: { primary: "clp", secondary: ["usd"] },
    installments: true,
    cuota_split: "round_half_up_last_absorbs",
    unbilled_listing: true,
    listing_feed: { names_card_by: "contract_number", batch_kind: "cc_santander_fetch" },
    sort_order: 0,
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: true },
    web_paste: { card_group: "santander", sign: "charges_negative" },
    close_day_offset_days: 0,
    first_cuota: { cuota_comercio: "next_cycle", precio_contado: "purchase_cycle" },
    parser_layout_prefixes: [],
    monto_facturado_tolerance_pct: 0.025,
    merchant_suffixes: null,
    facturado_paid_at_merchant_prefixes: [],
  },
  {
    slug: "bci",
    display_brand: "Lider",
    statement_currencies: { primary: "clp", secondary: ["usd"] },
    installments: true,
    cuota_split: "floor_last_absorbs",
    unbilled_listing: true,
    listing_feed: { names_card_by: "card_last4", batch_kind: "cc_lider_fetch" },
    sort_order: 10,
    derived_pay_by: { kind: "next_month_day", day: 10, prior_business_day: false },
    web_paste: { card_group: "BCI", sign: "charges_positive" },
    close_day_offset_days: 1,
    first_cuota: { cuota_comercio: "purchase_cycle", precio_contado: "purchase_cycle" },
    parser_layout_prefixes: ["bci_lider"],
    monto_facturado_tolerance_pct: 0.005,
    merchant_suffixes: "bci_terminal_and_city",
    facturado_paid_at_merchant_prefixes: ["RECAUDACION", "EXPRESS", "EXP LIDER", "HIP LIDER", "HIPER LIDER", "LIDER"],
  },
  {
    slug: "cmr",
    display_brand: "CMR",
    statement_currencies: { primary: "clp", secondary: ["usd"] },
    installments: true,
    cuota_split: "floor_last_absorbs",
    unbilled_listing: false,
    listing_feed: null,
    sort_order: 20,
    derived_pay_by: { kind: "close_plus_days", days: 16 },
    web_paste: { card_group: "CMR", sign: "charges_positive" },
    close_day_offset_days: 1,
    first_cuota: { cuota_comercio: "purchase_cycle", precio_contado: "purchase_cycle" },
    parser_layout_prefixes: [],
    monto_facturado_tolerance_pct: 0.025,
    merchant_suffixes: null,
    facturado_paid_at_merchant_prefixes: [],
  },
  {
    // A fictional US bank (the demo's US chapter): USD only, one monthly statement closing on a
    // fixed day of the month, the next cycle starting the day after, due 25 days after the close.
    // No cuotas (a US card has none), no feed, no paste.
    slug: "lonestar",
    display_brand: "Lonestar",
    statement_currencies: { primary: "usd", secondary: [] },
    installments: false,
    cuota_split: "floor_last_absorbs",
    unbilled_listing: false,
    listing_feed: null,
    sort_order: 30,
    derived_pay_by: { kind: "close_plus_days", days: 25 },
    web_paste: { card_group: "LONESTAR", sign: "charges_positive" },
    close_day_offset_days: 1,
    first_cuota: { cuota_comercio: "purchase_cycle", precio_contado: "purchase_cycle" },
    parser_layout_prefixes: [],
    monto_facturado_tolerance_pct: 0.005,
    merchant_suffixes: null,
    facturado_paid_at_merchant_prefixes: [],
  },
  {
    // A fictional European bank (docs/any-currency-plan.md, Phase C3): a card that bills in euros
    // only, held by tests as the case of a card in a third currency. Its rules copy Lonestar's —
    // a fixed close, the next cycle the day after, due 25 days later, no cuotas, no listing.
    slug: "euronova",
    display_brand: "Euronova",
    statement_currencies: { primary: "eur", secondary: [] },
    installments: false,
    cuota_split: "floor_last_absorbs",
    unbilled_listing: false,
    listing_feed: null,
    sort_order: 40,
    derived_pay_by: { kind: "close_plus_days", days: 25 },
    web_paste: { card_group: "EURONOVA", sign: "charges_positive" },
    close_day_offset_days: 1,
    first_cuota: { cuota_comercio: "purchase_cycle", precio_contado: "purchase_cycle" },
    parser_layout_prefixes: [],
    monto_facturado_tolerance_pct: 0.005,
    merchant_suffixes: null,
    facturado_paid_at_merchant_prefixes: [],
  },
] as const satisfies readonly CcIssuerDef[];

export type CcIssuer = (typeof CC_ISSUERS)[number];

export type CcIssuerSlug = (typeof CC_ISSUERS)[number]["slug"];

export function ccMasterImportKeyPrefix(slug: CcIssuerSlug): string {
  return `credit_card_master|${slug}|`;
}

export function ccIssuerBySlug(slug: string): (typeof CC_ISSUERS)[number] | null {
  return CC_ISSUERS.find((i) => i.slug === slug) ?? null;
}

/** A stored issuer: one of `CC_ISSUERS`, else it throws (an issuer the code has no rules for). */
export function requireCcIssuerSlug(value: string | null | undefined, context: string): CcIssuerSlug {
  const issuer = value != null ? ccIssuerBySlug(value) : null;
  if (!issuer) throw new Error(`${context}: unknown card issuer ${JSON.stringify(value ?? null)}`);
  return issuer.slug;
}

/** The issuer whose web-paste card group this is; a group no issuer pastes under throws. */
export function ccIssuerForWebPasteCardGroup(cardGroup: string | null | undefined): CcIssuer {
  const g = String(cardGroup ?? "").trim().toLowerCase();
  const issuer = CC_ISSUERS.find((i) => i.web_paste.card_group.toLowerCase() === g);
  if (!issuer) throw new Error(`No card issuer pastes under card group ${JSON.stringify(cardGroup ?? null)}`);
  return issuer;
}

/** The issuer a statement parser layout belongs to, when the layout is issuer-specific (else null). */
export function ccIssuerForParserLayout(layout: string | null | undefined): CcIssuer | null {
  const l = String(layout ?? "");
  return CC_ISSUERS.find((i) => i.parser_layout_prefixes.some((p) => l.startsWith(p))) ?? null;
}

/**
 * A statement row's or plan's card group, as stored: the legacy parser groups (`A`, `B`, `INTL`),
 * an issuer's paste group, or none — which every reader has always read as `A`, the parser's
 * default group.
 */
export function ccCardGroupOrDefault(cardGroup: string | null | undefined): string {
  return String(cardGroup ?? "A").trim() || "A";
}

/**
 * Whether a plan filed under `planGroup` can be a statement's plan of `statementGroup` on a card
 * whose listings paste under `webPasteGroup`: the same group, or a plan converted from a pasted
 * line (it inherits the paste group, the statements keep the parser's) — the one rule the
 * manual-plan reconcile applies.
 */
export function ccCardGroupsCompatible(planGroup: string, statementGroup: string, webPasteGroup: string): boolean {
  const plan = ccCardGroupOrDefault(planGroup);
  return plan === ccCardGroupOrDefault(statementGroup) || plan === webPasteGroup;
}
