/**
 * The nightly AFC read (Fondo de Cesantía, personas.afc.cl):
 *
 *   npm run fetch:afc -w nw-tracker-ingest                          # report only
 *   npm run fetch:afc -w nw-tracker-ingest -- --apply --background  # write (the nightly)
 *
 * Signs in with the AFC's own clave (RUT from `cfraser/afc-fetch.json`, clave from its Keychain
 * item — no second factor; `--clave-unica` takes the ClaveÚnica path with its e-mail code
 * instead, Keychain `nw-tracker-clave-unica`), then:
 *
 *  1. reads the home page's own summary call (`sva-portada/v1`: the stated saldo and the last
 *     contribution month the fund has credited) and sends it as `unemployment_fund.balance` —
 *     the server keeps the reading beside the app's value of the account; report only;
 *  2. has the page produce the certificate of paid contributions over the whole history (its
 *     «Cotizaciones pagadas» card, «Histórico», «Descargar» — the API behind it wants the page's
 *     own captcha token), keeps it as `cfraser/afc-certs/cotizaciones-latest.pdf`, parses it and
 *     sends it with every cartola staged under `cfraser/afc-certs/cartolas/` (the mail fetcher's) as one
 *     `unemployment_fund.documents` — idempotent: a contribution already in the ledger is unchanged,
 *     a new one (the employer's payment credited at the fund) is written at its pay date.
 *
 * A «Saldo no disponible» home page (the summary call answered 500 on two of seven captures) is
 * reported as an unavailable balance, never as zero. Exit status: non-zero when the sign-in, a
 * document or the server fails.
 */
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import {
  unemploymentFundBalanceKind,
  unemploymentFundDocumentsKind,
  type UnemploymentFundBalanceApplyDetails,
  type UnemploymentFundDocumentsApplyDetails,
} from "nw-tracker-contracts";
import { firstPage, launchBrowser } from "../browser.js";
import { CLAVE_UNICA_KEYCHAIN_SERVICE, saveClaveUnicaDiagnostics, signInWithClaveUnica } from "../claveUnica/login.js";
import { waitForClaveUnicaCode } from "../claveUnica/codeMail.js";
import { loadBankConfig } from "../config.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { assertRunAllowed } from "../runGuard.js";
import { decodeDataUrl } from "../wait.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { afcIsSignedIn } from "./capture.js";
import { signInWithAfcClave } from "./login.js";
import { parseAfcCartola, parseAfcCotizacionesCertificate, pdfTextLayout, unemploymentFundDocumentsPayload } from "./documents.js";
import { resolveAfcCartolasDir } from "../email/afcCartolas.js";

const BANK = "afc" as const;
const START_URL = "https://personas.afc.cl/auth/login";
const API = "https://apis.afc.cl";
const PORTADA_PATH = "/sva-portada/v1";
const HOME_WAIT_MS = 60_000;

export type AfcLoginMethod = "afc" | "clave_unica";
export type AfcFetchOptions = {
  apply: boolean;
  background: boolean;
  force: boolean;
  minIntervalMinutes: number;
  login: AfcLoginMethod;
  /** The payroll month (YYYY-MM) whose contribution this read looks for, when the server named one. */
  expectedPeriod?: string | null;
  /** The certificate still lacking `expectedPeriod` fails the run: its month has ended with no payment credited. */
  overdue?: boolean;
};

type Portada = { status: number; saldo: number | null; fechaUltimaCotizacion: string | null; error: string | null };

export function resolveAfcCertsDir(): string {
  return ensureDir(path.join(resolveCfraserDir(), "afc-certs"));
}

/** `2026-04-01` (fechaUltimaCotizacion) → `2026-04`; anything else throws. */
export function contributionMonthFromPortada(raw: string | null): string | null {
  if (raw == null) return null;
  const m = /^(\d{4})-(\d{2})-\d{2}/.exec(raw);
  if (!m) throw new Error(`AFC: fechaUltimaCotizacion «${raw}» is not a date`);
  return `${m[1]}-${m[2]}`;
}

async function readHome(page: Page): Promise<{ portada: Portada | null }> {
  let portada: Portada | null = null;
  page.on("response", (response) => {
    void (async () => {
      const url = response.url();
      if (!url.startsWith(API)) return;
      if (url === `${API}${PORTADA_PATH}` || url === `${API}${PORTADA_PATH}/`) {
        const json = (await response.json().catch(() => null)) as
          | { respuestaExitosa?: boolean; datos?: { saldo?: number; fechaUltimaCotizacion?: string | null } | null; error?: { descripcion?: string } | null }
          | null;
        if (json?.respuestaExitosa && json.datos) {
          const saldo = json.datos.saldo;
          if (typeof saldo !== "number") throw new Error(`AFC: portada without a numeric saldo: ${JSON.stringify(json.datos).slice(0, 200)}`);
          portada = { status: response.status(), saldo, fechaUltimaCotizacion: json.datos.fechaUltimaCotizacion ?? null, error: null };
        } else {
          portada = { status: response.status(), saldo: null, fechaUltimaCotizacion: null, error: json?.error?.descripcion ?? `HTTP ${response.status()}` };
        }
      }
    })().catch((err: unknown) => log(`AFC: home API response not read — ${err instanceof Error ? err.message : String(err)}`));
  });
  const deadline = Date.now() + HOME_WAIT_MS;
  // The poll starts before the sign-in: a sign-in that fails closes the browser under it, and the
  // sign-in's own error is the one to report — never this poll's.
  while (!portada && Date.now() < deadline && !page.isClosed()) await page.waitForTimeout(500).catch(() => undefined);
  return { portada };
}

const CERTIFICADOS_URL = "https://personas.afc.cl/documentos/certificados";
const CLICK_TIMEOUT_MS = 10_000;
const DOWNLOAD_WAIT_MS = 60_000;

/** The first visible element with exactly this text, clicked; throws when there is none. */
async function clickVisibleText(page: Page, text: string): Promise<void> {
  const target = page.locator("body").getByText(text, { exact: true }).locator("visible=true").first();
  if (!(await target.count().catch(() => 0))) throw new Error(`AFC: «${text}» is not on the page (${page.url()})`);
  await target.click({ timeout: CLICK_TIMEOUT_MS });
}

/**
 * The certificate of paid contributions, as the page itself produces it: its «Cotizaciones
 * pagadas» card, «Histórico» in the period chooser, «Descargar». The certificate API refuses a
 * direct call («Error sin captcha», 2026-10-17): the page attaches its invisible reCAPTCHA's token
 * and hands the PDF over as a page-built blob, which browser.ts's init script keeps on
 * `window.__nwInlineDownloads`.
 */
async function downloadCertificatePdf(page: Page): Promise<Buffer> {
  await page.goto(CERTIFICADOS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3_000);
  await clickVisibleText(page, "Cotizaciones pagadas");
  await page.waitForTimeout(1_500);
  await clickVisibleText(page, "Seleccione período");
  await page.waitForTimeout(1_000);
  await clickVisibleText(page, "Histórico");
  await page.waitForTimeout(1_000);
  // Emptied in place: the init script keeps its own reference to the array, so a fresh array
  // here would receive nothing (run 9, 2026-10-17).
  await page.evaluate(() => {
    const w = window as unknown as { __nwInlineDownloads?: unknown[] };
    (w.__nwInlineDownloads ?? []).splice(0);
  });
  const download = page.waitForEvent("download", { timeout: DOWNLOAD_WAIT_MS }).catch(() => null);
  await clickVisibleText(page, "Descargar");
  const deadline = Date.now() + DOWNLOAD_WAIT_MS;
  while (Date.now() < deadline) {
    const entries = await page
      .evaluate(() => {
        const w = window as unknown as { __nwInlineDownloads?: { name: string; href: string }[] };
        return (w.__nwInlineDownloads ?? []).splice(0);
      })
      .catch(() => [] as { name: string; href: string }[]);
    const pdf = entries.find((e) => e.href.startsWith("data:application/pdf") || /\.pdf$/i.test(e.name));
    if (pdf) {
      const bytes = decodeDataUrl(pdf.href);
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`AFC: the page-built file «${pdf.name}» is not a PDF`);
      log(`AFC: certificate «${pdf.name}» (${bytes.length} bytes)`);
      return bytes;
    }
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (/captcha/i.test(text)) throw new Error("AFC: the page asks for a captcha — not worked around");
    await page.waitForTimeout(500);
  }
  const native = await download;
  if (native) {
    const file = await native.path();
    if (file) {
      log(`AFC: certificate downloaded as «${native.suggestedFilename()}»`);
      return fs.readFileSync(file);
    }
  }
  throw new Error(`AFC: no certificate PDF within ${DOWNLOAD_WAIT_MS / 1000} s of «Descargar» (${await saveClaveUnicaDiagnostics(page, "afc-certificate")})`);
}

export async function runAfcFetch(opts: AfcFetchOptions): Promise<number> {
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(opts.login === "clave_unica" ? CLAVE_UNICA_KEYCHAIN_SERVICE : config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, opts.minIntervalMinutes, opts.force);
  const now = new Date();
  const context = await launchBrowser({ bank: BANK, headless: false, background: opts.background });
  let home: Awaited<ReturnType<typeof readHome>>;
  let certificatePdf: Buffer;
  try {
    let page = await firstPage(context);
    const homeRead = readHome(page);
    await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    page =
      opts.login === "clave_unica"
        ? await signInWithClaveUnica(page, {
            run: config.rut,
            clave,
            label: "AFC",
            isSignedIn: afcIsSignedIn,
            code: (requestedAt) => waitForClaveUnicaCode({ requestedAt }),
          })
        : await signInWithAfcClave(page, { rut: config.rut, clave, label: "AFC", isSignedIn: afcIsSignedIn });
    home = await homeRead;
    certificatePdf = await downloadCertificatePdf(page);
  } finally {
    await context.close().catch(() => undefined);
  }

  // The certificate: kept as the latest copy (the cartola import's base), parsed, sent with the cartolas.
  const certsDir = resolveAfcCertsDir();
  const latest = path.join(certsDir, "cotizaciones-latest.pdf");
  fs.writeFileSync(latest, certificatePdf);
  const cert = parseAfcCotizacionesCertificate(pdfTextLayout(latest));
  const last = cert.legs[cert.legs.length - 1];
  log(`AFC: certificate — ${cert.legs.length} legs, total ${cert.total_clp} CLP, latest ${last?.period_ym ?? "—"} paid ${last?.pay_ymd ?? "—"}`);
  let failed = false;
  if (opts.expectedPeriod && (last == null || last.period_ym < opts.expectedPeriod)) {
    if (opts.overdue) {
      log(`AFC: OVERDUE — the contribution for ${opts.expectedPeriod} is still not credited (certificate ends at ${last?.period_ym ?? "—"})`);
      failed = true;
    } else log(`AFC: the contribution for ${opts.expectedPeriod} is not credited yet (certificate ends at ${last?.period_ym ?? "—"})`);
  }
  const cartolaFiles = fs.existsSync(resolveAfcCartolasDir())
    ? fs.readdirSync(resolveAfcCartolasDir()).filter((f) => f.toLowerCase().endsWith(".pdf")).sort()
    : [];
  const cartolas = cartolaFiles.map((f) => parseAfcCartola(pdfTextLayout(path.join(resolveAfcCartolasDir(), f))));
  log(`AFC: ${cartolas.length} cartola(s) staged${cartolaFiles.length ? ` (${cartolaFiles.join(", ")})` : ""}`);

  try {
    const result = await ingestClient().send(
      unemploymentFundDocumentsKind,
      unemploymentFundDocumentsPayload(cert, cartolas, { apply: opts.apply, accountId: null, replaceExcelRows: false, dropMovementIds: [] }),
      { channel: "web_session", ref: "personas.afc.cl", label: "AFC sucursal virtual", fetched_at: now.toISOString() }
    );
    const d = result.details as UnemploymentFundDocumentsApplyDetails;
    for (const line of d.report) log(`  ${line}`);
    const wrote = /inserted (\d+)/.exec(d.report.join("\n"));
    if (d.applied && wrote && Number(wrote[1]) > 0) {
      const dated = path.join(certsDir, `${now.toISOString().slice(0, 10)}-cotizaciones.pdf`);
      fs.copyFileSync(latest, dated);
      log(`AFC: rows written — certificate kept as ${path.basename(dated)}`);
    }
  } catch (err) {
    log(`AFC documents FAILED — ${describeIngestFailure(err)}`);
    failed = true;
  }

  // The stated balance, report only.
  const portada = home.portada;
  try {
    const result = await ingestClient().send(
      unemploymentFundBalanceKind,
      {
        provider: "afc",
        read_at: now.toISOString(),
        balance_pesos: portada?.saldo ?? null,
        last_contribution_month: contributionMonthFromPortada(portada?.fechaUltimaCotizacion ?? null),
        unavailable_reason: portada ? portada.error : "the home page made no summary call",
      },
      { channel: "web_session", ref: "personas.afc.cl", label: "AFC sucursal virtual", fetched_at: now.toISOString() }
    );
    const d = result.details as UnemploymentFundBalanceApplyDetails;
    if (d.stated_pesos == null) log(`AFC balance: not available (${portada?.error ?? "no summary"}); app ${d.app_value_clp} CLP`);
    else {
      log(
        `AFC balance: site ${d.stated_pesos} CLP, app ${d.app_value_clp} CLP, difference ${d.difference_clp} (${d.difference_pct ?? 0}%)` +
          `; last credited month ${portada?.fechaUltimaCotizacion?.slice(0, 7) ?? "—"} (ledger ${d.ledger_last_contribution_month ?? "—"})`
      );
    }
  } catch (err) {
    log(`AFC balance FAILED — ${describeIngestFailure(err)}`);
    failed = true;
  }
  return failed ? 1 : 0;
}
