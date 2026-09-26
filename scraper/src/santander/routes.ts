/**
 * Public site. Login must start here: the login frame is designed to be EMBEDDED, and loading it
 * top-level makes the auth call fail with 403 (the origin the token endpoint sees is wrong).
 */
export const HOME_URL = "https://banco.santander.cl";

/** Angular home-banking SPA the login redirects to. Everything below the base is hash routing. */
export const APP_BASE = "https://mibanco.santander.cl/UI.Web.HB/Private_new/frame/";

/**
 * The hosts a login touches: the public homepage and the private-app host, which also serves the
 * `#login-frame` document. Both must answer before Chrome is worth launching (`waitForHosts`).
 */
export const LOGIN_HOSTS = [new URL(HOME_URL).host, new URL(APP_BASE).host] as const;

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
  /**
   * The toast the login panel shows over the form when the bank rejects the login. Two wordings so
   * far: «Ocurrió un error al ingresar a tu banco en línea…» (2026-09-11, the bank's side — a manual
   * login showed the same) and «Alguno de los datos ingresados es incorrecto. Por favor, revisa tu RUT
   * y Clave Digital…» (2026-09-14, wrong credentials). The toast lives in the top-level page next to
   * the `#login-frame` iframe, not inside it. The window never leaves the public site either way.
   */
  loginRejected: /ocurri[oó] un error al ingresar|alguno de los datos ingresados es incorrecto/i,
  /** The wording that means the stored clave is wrong — the one that latches further logins off. */
  loginCredentialsRejected: /alguno de los datos ingresados es incorrecto/i,
  /**
   * The card the login panel renders in place of the `#login-frame` iframe when the frame's document
   * (served by the private-app host) fails to load: «No fue posible ingresar a tu banco en línea.
   * Comprueba tu conexión a internet e inténtalo nuevamente.» over a «Volver a intentar» button.
   * First seen 2026-09-25, 40 s after a wake from hibernation. Top-level page, like the toast.
   */
  loginPanelConnectionError: /no fue posible ingresar a tu banco en l[ií]nea/i,
  /** The connection-error card's retry button. Full phrase: nothing else on the page may match. */
  loginPanelRetry: /^\s*volver a intentar\s*$/i,
} as const;
