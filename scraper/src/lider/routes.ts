export const LOGIN_URL = "https://www.liderbciserviciosfinancieros.cl/login";

export const SELECTOR = {
  /** Neither visible input carries an id; the RUT is identified by its placeholder. */
  loginRut: 'input[placeholder="Rut" i]',
  loginPass: 'input[formcontrolname="pass"]',
  loginSubmit: 'button[type="submit"]:not(.evg-nav-btn)',
  /** Cloudflare writes the solved token here; a non-empty value means the check passed. */
  turnstileToken: 'input[name="cf-turnstile-response"]',
} as const;

export const TEXT = {
  moreMovements: /ver\s+m[áa]s\s+movimientos/i,
  /** Movement tabs: nacionales = CLP, internacionales = USD. */
  nacionales: /nacionales/i,
  internacionales: /internacionales/i,
  statementSection: /estado\s+de\s+cuenta/i,
  downloadStatement: /descargar\s+estado\s+de\s+cuenta/i,
} as const;
