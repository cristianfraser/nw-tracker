/**
 * Public site. Login must start here: the login frame is designed to be EMBEDDED, and loading it
 * top-level makes the auth call fail with 403 (the origin the token endpoint sees is wrong).
 */
export const HOME_URL = "https://banco.santander.cl";

/** Angular home-banking SPA the login redirects to. Everything below the base is hash routing. */
export const APP_BASE = "https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/";

export const ROUTE = {
  login: "/public/login-frame/ing/0010",
  /** Credit card, current (unbilled) period — "no facturado". */
  cardUnbilled: "/private/Saldos_TC/main/bill",
  /** Credit card, billed periods — carries "Pagar hasta" + "Ver estado de cuenta". */
  cardBilled: "/private/Saldos_TC/main/billed",
  /** Cuenta corriente movements — carries "Descargar últimos movimientos" + "Ir a cartolas". */
  checkingMovements: "/private/saldos/main/movimientos",
} as const;

/** API endpoints (basenames under `api-dsk.santander.cl/perdsk/…`). */
export const ENDPOINT = {
  cardMovements: "consultaUltimosMovimientos",
  cardStatement: "estadoCuentaNacional",
} as const;

export const SELECTOR = {
  /**
   * Opens the login panel on the public homepage; the frame is created lazily by this click.
   *
   * The homepage ships in at least two markup variants — one uses `a.btn-ingresar`
   * (aria "Abrir panel de ingreso"), the other generic button classes with aria "Ingresar al sitio
   * privado" (both observed 2026-08-05, same URL, minutes apart). Match on either.
   */
  openLoginPanel: 'a.btn-ingresar, a[aria-label*="sitio privado" i], a[aria-label*="panel de ingreso" i]',
  /** Dismisses the fraud-warning banner that can overlay the header. */
  closeNotice: 'a.btn-close[aria-label="Cerrar aviso"]',
  /**
   * Close button of a marketing modal (`div.modal-overlay[role="dialog"]`) the homepage sometimes
   * opens on load — «Santander Arena», first seen 2026-09-05. Its overlay covers the whole page and
   * swallows the click on the login button until it is closed. Only a dialog's own close control is
   * matched, never an arbitrary button, so a real login prompt can't be dismissed by mistake.
   */
  closeModal: '[role="dialog"] button[aria-label="Cerrar modal"], [role="dialog"] button.modal-close',
  /** The embedded login frame. Fields live inside it, not in the top-level document. */
  loginFrame: "#login-frame",
  loginRut: "#rut",
  loginPass: "#pass",
  loginSubmit: 'button[type="submit"]',
  swiperNext: ".swiper-button-next",
  swiperDisabled: "swiper-button-disabled",
} as const;

/** Text triggers, matched case-insensitively so accents/casing changes don't break the run. */
export const TEXT = {
  downloadCheckingMovements: /descargar\s+últimos\s+movimientos/i,
  goToCartolas: /ir\s+a\s+cartolas/i,
  downloadExcel: /descargar\s+excel/i,
  viewStatement: /ver\s+estado\s+de\s+cuenta/i,
  payBy: /pagar\s+hasta:?\s*(\d{2})\/(\d{2})\/(\d{4})/i,
  /** Currency tabs above the movements table — USD only loads once "Dólares" is clicked. */
  currencyClp: /^\s*pesos\s*$/i,
  currencyUsd: /^\s*dólares\s*$/i,
  /** A rendered cartola row; until it appears the list is still skeleton placeholders. */
  cartolaIssued: /cartola\s+emitida/i,
  /**
   * The «¿Necesitas más tiempo?» inactivity prompt's keep button. Its sibling is «Cerrar sesión»,
   * which must never be matched — hence the full phrase, not a bare «sesión».
   */
  keepSession: /mantener\s+sesi[oó]n/i,
} as const;
