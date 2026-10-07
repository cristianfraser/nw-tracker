/**
 * Read AFP UNO's mandatory account and send it to the server as one
 * `pension_account.certificates`:
 *
 *   npm run fetch:afp-uno -w nw-tracker-ingest                          # report only
 *   npm run fetch:afp-uno -w nw-tracker-ingest -- --apply --background  # write (the nightly)
 *
 * The private site signs in from www.uno.cl (RUT + clave; the page's own invisible reCAPTCHA
 * makes its token — nothing here touches it) and its home page then calls the portal's JSON
 * API for the stated balance (`productos-voluntarios/consulta`) and the recent movements
 * (`afiliado-movimientos/movimientos-portal`, tipoProducto CCO). The two certificates are asked
 * of the same API with the headers the page itself sent: `afiliado-certificado/cotizaciones` (12
 * períodos) and `afiliado-certificado/movimientos-pdf` (the last 12 months), each a base64 PDF.
 * The server decides what is new.
 *
 * The PDFs are kept only when the server wrote rows from them (`cfraser/afp-uno-certs/
 * <issued>-cotizaciones.pdf` / `-movimientos.pdf`, the evidence for those rows); a read with
 * nothing new deletes them — the site issues the same certificates again on request. A
 * certificate that does not parse stays in `afp-uno-certs/incoming/` for a look, until the next
 * run clears it.
 *
 * Exit status: non-zero when the read fails or the server reports a problem.
 */
import fs from "node:fs";
import path from "node:path";
import type { APIRequestContext, Page } from "playwright-core";
import {
  pensionAccountCertificatesKind,
  type PensionAccountCertificatesApplyDetails,
  type PensionAccountCertificatesPayload,
} from "nw-tracker-contracts";
import { firstPage, launchBrowser } from "../browser.js";
import { loadBankConfig } from "../config.js";
import { parseChileanNumber } from "../formats/chileanNumber.js";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { ensureDir, resolveCfraserDir } from "../paths.js";
import { assertRunAllowed, DEFAULT_MIN_INTERVAL_MINUTES } from "../runGuard.js";
import { chileWallClock } from "../santander/catchUp.js";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { parseContributionsCertificate, parseMovementsCertificate, pdfLayoutText } from "./certificates.js";
import { tryLogin } from "./login.js";

const BANK = "afp-uno" as const;
const START_URL = "https://www.uno.cl/";
const PORTAL_API = "https://portal.uno.cl/api";
const LOGIN_RESPONSE = /\/api\/autenticar(?:\?|$)/;
const HOME_WAIT_MS = 90_000;
const CERTIFICATE_PERIODS = 12;

const apply = process.argv.includes("--apply");
const background = process.argv.includes("--background");
const force = process.argv.includes("--force");

type PortalMovement = {
  periodoCotizacion: string;
  codigoMovimiento: string;
  descripcionMovimiento: string;
  fechaAcreditacion: string;
  valorMilesMovimiento: string;
  valorCuotasMovimiento: string;
};

type ConsultaFund = { saldo: number; saldoCuota: number; tipo: string; valorCuota: number };

type HomeRead = {
  /** Headers of the page's own portal API call — its session, replayed for the certificates. */
  headers: Record<string, string>;
  movements: PortalMovement[];
  fund: ConsultaFund;
};

function certsDir(): string {
  return ensureDir(path.join(resolveCfraserDir(), "afp-uno-certs"));
}

function incomingDir(): string {
  return ensureDir(path.join(certsDir(), "incoming"));
}

function yyyymmToPeriod(raw: string): string {
  if (!/^\d{6}$/.test(raw)) throw new Error(`AFP UNO: período "${raw}" is not YYYYMM`);
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function yyyymmddToIso(raw: string): string {
  if (!/^\d{8}$/.test(raw)) throw new Error(`AFP UNO: date "${raw}" is not YYYYMMDD`);
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6)}`;
}

/** The headers worth replaying: the session's, never the transport's. */
function replayHeaders(all: Record<string, string>): Record<string, string> {
  const drop = new Set(["host", "content-length", "cookie", "connection", "accept-encoding"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(all)) if (!drop.has(k.toLowerCase()) && !k.startsWith(":")) out[k] = v;
  return out;
}

/** A screenshot and the page's text, for an unattended failure; returns where they went. */
async function saveDiagnostics(page: Page, label: string): Promise<string> {
  const base = path.join(ensureDir(path.join(resolveCfraserDir(), "scraper-diagnostics")), `${label}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  try {
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    fs.writeFileSync(`${base}.txt`, `${page.url()}\n\n${await page.evaluate(() => document.body?.innerText ?? "")}`);
    return `see ${path.relative(resolveCfraserDir(), base)}.png`;
  } catch (err) {
    return `no screenshot: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Sign in and wait for the home page's own API calls. One retry, as a person would reload: the
 * site's invisible captcha sometimes rejects the first attempt and passes on a reload.
 */
async function signInAndReadHome(page: Page, rut: string, clave: string): Promise<HomeRead> {
  let movements: { list: PortalMovement[]; headers: Record<string, string> } | null = null;
  let fund: ConsultaFund | null = null;
  page.on("response", (response) => {
    void (async () => {
      const url = response.url();
      if (!url.startsWith(PORTAL_API) || response.status() !== 200) return;
      if (url.includes("/afiliado-movimientos/movimientos-portal")) {
        const body = response.request().postDataJSON() as { tipoProducto?: string } | null;
        if (body?.tipoProducto !== "CCO") return;
        const json = (await response.json()) as { codigo?: string; mensaje?: string; movimientoPortalList?: PortalMovement[] };
        if (json.codigo !== "0") throw new Error(`movimientos-portal: ${json.mensaje ?? "no codigo 0"}`);
        movements = { list: json.movimientoPortalList ?? [], headers: replayHeaders(await response.request().allHeaders()) };
      } else if (url.includes("/productos-voluntarios/consulta")) {
        const json = (await response.json()) as {
          respuestaTraerDetalleSaldos?: { cuentaDetalleSaldo?: { cuenta: string; fondo: ConsultaFund[] }[] };
        };
        const cco = json.respuestaTraerDetalleSaldos?.cuentaDetalleSaldo?.filter((c) => c.cuenta === "CCO") ?? [];
        // The page also asks about the voluntary products; those answers carry no CCO.
        if (cco.length === 0) return;
        if (cco.length !== 1 || cco[0]!.fondo.length !== 1) {
          throw new Error(`consulta: expected one CCO account in one fund, got ${JSON.stringify(cco).slice(0, 300)}`);
        }
        fund = cco[0]!.fondo[0]!;
      }
    })().catch((err: unknown) => log(`AFP UNO: home API response not read — ${err instanceof Error ? err.message : String(err)}`));
  });

  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 1) await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    else {
      log("AFP UNO: reloading for a second sign-in attempt");
      await page.goto(START_URL, { waitUntil: "domcontentloaded" });
    }
    const answer = page.waitForResponse((r) => LOGIN_RESPONSE.test(r.url()), { timeout: 60_000 });
    // Settled by whoever awaits it below; a sign-in that throws first must not leave it unhandled.
    answer.catch(() => undefined);
    if (!(await tryLogin(page, rut, clave))) {
      throw new Error(`AFP UNO: sign-in form not found on www.uno.cl (${await saveDiagnostics(page, "afp-uno-login")})`);
    }
    const response = await answer;
    const body = (await response.json().catch(() => null)) as { codigo?: string; mensaje?: string } | null;
    if (body?.codigo === "0") break;
    const why = body?.mensaje ?? `HTTP ${response.status()}`;
    if (attempt === 2) throw new Error(`AFP UNO: sign-in refused twice — «${why}»`);
    log(`AFP UNO: sign-in refused — «${why}»`);
  }

  const deadline = Date.now() + HOME_WAIT_MS;
  while ((!movements || !fund) && Date.now() < deadline) await page.waitForTimeout(500);
  if (!movements || !fund) {
    log(`AFP UNO: ${await saveDiagnostics(page, "afp-uno-home")}`);
    throw new Error(`AFP UNO: the home page did not load its ${!movements ? "movements" : "balance"} within ${HOME_WAIT_MS / 1000} s`);
  }
  const m = movements as { list: PortalMovement[]; headers: Record<string, string> };
  return { headers: m.headers, movements: m.list, fund: fund as ConsultaFund };
}

async function certificatePdf(api: APIRequestContext, headers: Record<string, string>, endpoint: string, body: object): Promise<Buffer> {
  const res = await api.post(`${PORTAL_API}/afiliado-certificado/${endpoint}`, { headers, data: body, timeout: 90_000 });
  if (!res.ok()) throw new Error(`AFP UNO ${endpoint}: HTTP ${res.status()}`);
  const json = (await res.json()) as { codigo?: string; mensaje?: string; data?: { bytes?: string } };
  if (json.codigo !== "0" || !json.data?.bytes) throw new Error(`AFP UNO ${endpoint}: ${json.mensaje ?? "no certificate"}`);
  const pdf = Buffer.from(json.data.bytes, "base64");
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error(`AFP UNO ${endpoint}: the answer is not a PDF`);
  return pdf;
}

function monthsBack(ym: string, months: number): string {
  const [y, m] = [Number(ym.slice(0, 4)), Number(ym.slice(4))];
  const idx = y * 12 + (m - 1) - months;
  return `${Math.floor(idx / 12)}${String((idx % 12) + 1).padStart(2, "0")}`;
}

function printDetails(d: PensionAccountCertificatesApplyDetails): void {
  for (const r of d.rows) {
    const id = r.movement_id != null ? ` → movement ${r.movement_id}` : "";
    console.log(
      `  ${r.occurred_on ?? "(pending)"}  ${r.period}  ${r.kind.padEnd(22)} ${String(r.pesos).padStart(9)} clp ${r.cuotas.toFixed(2).padStart(7)} cuotas  [${r.state}${id}]${r.detail ? ` ${r.detail}` : ""}`
    );
  }
  console.log(`  balance: stated ${d.balance.stated_cuotas.toFixed(4)} cuotas, ledger after this read ${d.balance.ledger_cuotas_after.toFixed(4)}`);
  const v = d.value_check;
  console.log(
    v.status === "waiting"
      ? `  value: website ${v.site_pesos} pesos — ${v.detail}`
      : `  value: website ${v.site_pesos} pesos (${v.site_cuotas} × ${v.site_valor_cuota}), app ${v.app_pesos} on ${v.app_day} — ${v.status}${v.status === "mismatch" ? ` (${v.diff_clp})` : ""}`
  );
  if (d.applied) console.log(`  → ${d.inserted} row(s) written`);
  for (const p of d.problems) console.log(`  PROBLEM: ${p}`);
}

async function main(): Promise<number> {
  // Config and Keychain first: a setup error is not a run and must not start the guard's clock.
  const config = loadBankConfig(BANK);
  const clave = readKeychainSecret(config.keychain_service, config.loginAccount);
  assertRunAllowed(BANK, DEFAULT_MIN_INTERVAL_MINUTES, force);

  // A run's certificates are kept or deleted when it ends; anything left here is from a run
  // that failed to parse them, and the certificates of this run supersede it.
  for (const stale of fs.readdirSync(incomingDir())) fs.rmSync(path.join(incomingDir(), stale), { force: true });

  const readAt = new Date();
  const ym = chileWallClock(readAt).slice(0, 7).replace("-", "");
  const context = await launchBrowser({ bank: BANK, headless: false, background });
  let home: HomeRead;
  let contributionsPdf: Buffer;
  let movementsPdf: Buffer;
  try {
    const page = await firstPage(context);
    home = await signInAndReadHome(page, config.rut, clave);
    log(`AFP UNO: signed in — ${home.fund.saldoCuota} cuotas in fund ${home.fund.tipo}, ${home.movements.length} recent movement(s)`);
    contributionsPdf = await certificatePdf(context.request, home.headers, "cotizaciones", {
      TipoProducto: "CCO",
      numPeriodos: String(CERTIFICATE_PERIODS),
      adjuntoCorreo: false,
    });
    movementsPdf = await certificatePdf(context.request, home.headers, "movimientos-pdf", {
      TipoFondo: home.fund.tipo,
      TipoProducto: "CCO",
      strPerDesde: monthsBack(ym, CERTIFICATE_PERIODS),
      strPerHasta: ym,
      adjuntoCorreo: false,
    });
  } finally {
    await context.close();
  }

  const stamp = readAt.toISOString().replace(/[:.]/g, "-");
  const files = {
    contributions: path.join(incomingDir(), `${stamp}-cotizaciones.pdf`),
    movements: path.join(incomingDir(), `${stamp}-movimientos.pdf`),
  };
  fs.writeFileSync(files.contributions, contributionsPdf);
  fs.writeFileSync(files.movements, movementsPdf);
  const contributions = parseContributionsCertificate(pdfLayoutText(contributionsPdf));
  const movements = parseMovementsCertificate(pdfLayoutText(movementsPdf));
  log(`AFP UNO: ${contributions.rows.length} contribution(s), ${movements.rows.length} movement(s) on the certificates`);

  const payload: PensionAccountCertificatesPayload = pensionAccountCertificatesKind.payload.parse({
    provider: "afp_uno",
    product: "mandatory",
    fund: home.fund.tipo,
    apply,
    read_at: readAt.toISOString(),
    balance: { cuotas: home.fund.saldoCuota, valor_cuota: home.fund.valorCuota, pesos: home.fund.saldo },
    recent_movements: home.movements.map((m) => ({
      credited_on: yyyymmddToIso(m.fechaAcreditacion),
      period: yyyymmToPeriod(m.periodoCotizacion),
      code: m.codigoMovimiento,
      description: m.descripcionMovimiento,
      pesos: parseChileanNumber(m.valorMilesMovimiento),
      cuotas: parseChileanNumber(m.valorCuotasMovimiento),
    })),
    contributions,
    movements,
  });

  let details: PensionAccountCertificatesApplyDetails;
  try {
    const result = await ingestClient().send(pensionAccountCertificatesKind, payload, {
      channel: "web_session",
      ref: `afp-uno-${stamp}`,
      fetched_at: readAt.toISOString(),
    });
    details = result.details as PensionAccountCertificatesApplyDetails;
  } catch (err) {
    console.log(`AFP UNO: FAILED — ${describeIngestFailure(err)}`);
    for (const f of Object.values(files)) fs.rmSync(f, { force: true });
    return 1;
  }
  console.log(`\nAFP UNO ${apply ? "" : "(report only) "}— folios ${contributions.folio} / ${movements.folio}`);
  printDetails(details);

  if (details.inserted > 0) {
    for (const [kind, file] of Object.entries(files)) {
      const name = kind === "contributions" ? "cotizaciones" : "movimientos";
      const kept = path.join(certsDir(), `${contributions.issued_on}-${name}.pdf`);
      fs.renameSync(file, kept);
      console.log(`  kept ${path.relative(resolveCfraserDir(), kept)}`);
    }
  } else {
    for (const f of Object.values(files)) fs.rmSync(f, { force: true });
  }
  if (!apply) console.log("\nReport only — nothing written.");
  return details.problems.length > 0 ? 1 : 0;
}

process.exitCode = await main().catch((err: unknown) => {
  log(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  return 1;
});
