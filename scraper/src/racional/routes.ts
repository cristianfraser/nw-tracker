/**
 * Racional web app (app.racional.cl) — an Ionic/Angular SPA.
 *
 * Everything here was verified against the live, logged-in app on 2026-08-05.
 *
 * **The movements list is NOT served by a REST call.** Opening «Movimientos» fires only
 * Firestore Listen-channel POSTs (`firestore.googleapis.com/.../projects/racional-prod/...`),
 * so intercepting XHR — the approach that works for Santander — yields nothing usable for
 * transactions. Holdings DO have a clean REST API. Hence the split:
 *
 *   - positions / cash  → `GET https://api.racional.cl/positions`
 *                         `GET https://api.racional.cl/positions/buying-power`
 *   - movements         → rendered DOM (`app-investment-movement` rows) + a detail view
 *
 * Reading movements out of the DOM is a deliberate trade-off: it is more fragile than an API,
 * but the alternative is re-implementing Firestore's auth + channel framing, which is a real
 * step up in both effort and adversarial posture for the same data.
 */
export const LOGIN_URL = "https://app.racional.cl/login";
export const HOME_URL = "https://app.racional.cl/tabs/home";
export const MOVEMENTS_URL = "https://app.racional.cl/tabs/movements";

/** Backend REST base. Only the positions endpoints are confirmed. */
export const API_BASE = "https://api.racional.cl";
export const API_HOST_FRAGMENT = "api.racional.cl";

export const SELECTOR = {
  /** Ionic wraps the real input; target the native element so fill()/inputValue() work. */
  loginEmail: 'ion-input[formcontrolname="email"] input',
  /**
   * The password lives in an `app-password-input` whose OUTER component is
   * `formcontrolname="password"` while the actual field is `passwordValue` — targeting the
   * outer name finds the component, not the input.
   */
  loginPassword: 'ion-input[formcontrolname="passwordValue"] input',
  loginSubmit: 'ion-button:has-text("Iniciar sesión"), button:has-text("Iniciar sesión")',
  /** «Mantener sesión» — the control itself, for reading its checked state. */
  keepSession: "ion-checkbox, ion-toggle, input[type=checkbox]",

  /** One rendered movement row. Angular component selector — stabler than a CSS class. */
  movementRow: "app-investment-movement",
  /** Inside a row: `.movement-description p.title` is the label, e.g. "Compra SLV". */
  movementTitle: ".movement-description p.title",
  movementBody: ".content-movement",
  /** The right-hand panel after a row is clicked. */
  movementDetail: "ion-content",
} as const;

export const TEXT = {
  movementsTab: /movimientos/i,
  home: /inicio/i,
  /** Ticking this is what keeps scheduled runs from triggering a fresh e-mail 2FA each night. */
  keepSession: /mantener\s+sesi[óo]n/i,
  /** The e-mailed verification step; only a supervised run can answer it. */
  verificationCode: /c[óo]digo\s+de\s+verificaci[óo]n|verificaci[óo]n|c[óo]digo/i,
} as const;

/**
 * The «Movimientos» filter chips, i.e. Racional's own taxonomy — the full set an importer has
 * to map. Mapping to nw-tracker flow kinds is the obvious one (compras → stock_buy, ventas →
 * stock_sell, dividendos → dividend_payout, intereses → savings_earnings), except
 * «Eventos Corporativos», which has no direct equivalent and needs a decision.
 */
export const MOVEMENT_KINDS = [
  "Depósitos",
  "Compras",
  "Ventas",
  "Dividendos",
  "Intereses Billetera",
  "Intereses Boost",
  "Retiros",
  "Comisiones",
  "Eventos Corporativos",
] as const;

/**
 * A movement's URL is its identity and it is stable and parseable:
 *   /movements/<uid>_<ISO timestamp>_<amount>?type=contribution&status=complete
 * e.g. `sw5tf…NRp2_2026-07-01T16:47:2x.xxxZ_1346.17?type=contribution&status=complete`.
 * The ISO timestamp + amount make a natural dedupe key without needing the bank's own id —
 * though the trade detail also prints one (`Orden #86365B402E0D`).
 */
export const RE_MOVEMENT_ID = /^(?<uid>[^_]+)_(?<iso>\d{4}-\d{2}-\d{2}T[\d:.]+Z)_(?<amount>[\d.]+)$/;

/**
 * The detail panel carries everything a `stock_buy` needs — verified on a real SLV purchase:
 *
 *   "Compraste US$x.xxx,xx de Silver Trust (SLV)."
 *   Monto comprado US$x.xxx,xx · Comisión US$x,xx · Total orden US$x.xxx,xx
 *   Orden #86365B402E0D
 *   "Recibiste 24,74186066 acciones de Silver Trust (SLV), a un valor de US$xx,xx por acción."
 *
 * Units carry 8 decimals, so parse them as decimal strings — never via a rounded float path.
 */
export const RE_DETAIL_UNITS =
  /Recibiste\s+([\d.,]+)\s+acciones\s+de\s+(.+?)\s*\((\w[\w.]*)\)\s*,\s*a un valor de\s+US\$([\d.,]+)\s+por acci[óo]n/i;
export const RE_DETAIL_ORDER_ID = /Orden\s+#([A-Z0-9]+)/i;
export const RE_DETAIL_COMMISSION = /Comisi[óo]n\s+US\$([\d.,]+)/i;
