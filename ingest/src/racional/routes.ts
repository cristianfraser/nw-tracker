/**
 * Racional web app (app.racional.cl), rebuilt in 2026-11 («Racional 2.0»: React, Firebase sign-in
 * followed by a passkey on a new session, data from its own server functions — see `appData.ts`).
 * Until then it was an Ionic/Angular app whose movements arrived over Firestore and were read
 * from the rendered list; that crawl is gone.
 */
export const APP_ORIGIN = "https://app.racional.cl";
export const LOGIN_URL = `${APP_ORIGIN}/login`;
export const HOME_URL = `${APP_ORIGIN}/home`;
export const POSITIONS_URL = `${APP_ORIGIN}/positions`;

export const SELECTOR = {
  /**
   * The login page was rebuilt (seen 2026-11-17: plain inputs with React ids, a Base UI checkbox,
   * a passkey button beside the submit), so the fields are found by type, not by component.
   */
  loginEmail: 'input[type="email"]',
  loginPassword: 'input[type="password"]',
  /** The form's submit; «Iniciar sesión con passkey» beside it is a plain button. */
  loginSubmit: 'button[type="submit"]',
  /** «Mantener sesión» — the control itself, for reading its checked state. */
  keepSession: '[role="checkbox"], input[type="checkbox"]',

  /** The menu's «Movimientos» link: a navigation inside the app, which asks the server for the list. */
  movementsLink: 'a[href="/movements"]',
  /**
   * One row of the movements list (2026-11-18: a clickable block holding the date, a dot, the
   * label in a truncated paragraph and the amount right-aligned), in the order of the answer.
   */
  movementRow: "div.cursor-pointer",
  movementLabel: "p.truncate",
  movementAmount: "span.text-right p",
} as const;

export const TEXT = {
  /** Ticking this is what keeps scheduled runs from triggering a fresh e-mail 2FA each night. */
  keepSession: /mantener\s+sesi[óo]n/i,
  /** The e-mailed verification step; only a supervised run can answer it. */
  verificationCode: /c[óo]digo\s+de\s+verificaci[óo]n|verificaci[óo]n|c[óo]digo/i,
} as const;

