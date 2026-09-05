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
export const MOVEMENTS_URL = "https://app.racional.cl/tabs/movements";

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

