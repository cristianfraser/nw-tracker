# scraper — bank navigator/parser

Fetches Santander movements and statements straight into `cfraser/inbox/`, so
`npm run import:cfraser-inbox` picks them up like any other document drop. Replaces the manual
movement entry / web-paste step.

**Not an npm workspace on purpose.** Render's build runs `npm install --include=dev` at the repo
root; adding this to `workspaces` would pull Playwright into the hosted demo deploy. Install it
separately:

```bash
npm install --prefix scraper
```

## Setup (once per bank)

Banks: **santander**, **lider**, **racional**. Each has its own config file, Keychain item, and
Chrome profile. Santander and Lider sign in with a **RUT**; Racional signs in with an **e-mail**
(`"email"` instead of `"rut"` in its config, and that same value is the Keychain account).

1. **Config** — personal identifiers stay in gitignored `cfraser/`, never in the repo
   (same convention as `cfraser/organize-identifiers.json`). Create `cfraser/<bank>-fetch.json`:

   ```json
   {
     "rut": "12.345.678-9",
     "keychain_service": "nw-tracker-santander"
   }
   ```

2. **Password** — macOS Keychain, never a dotfile. The flagless `-w` prompts, so the password never
   lands in shell history:

   ```bash
   security add-generic-password -s nw-tracker-santander -a "12.345.678-9" -w
   ```

## Running

```bash
npm run fetch:santander -- --capture           # first, supervised run
npm run fetch:lider -- --capture
npm run fetch:santander                        # normal run → cfraser/inbox/
npm run import:cfraser-inbox                   # existing pipeline takes it from there

npm run fetch:santander -- --only=cartola      # re-test one path, no extra requests
```

`--only=` narrows a run to named steps (`card-movements`, `checking-movements`, `card-statements`,
`cartola`; Lider: `movements`, `statement`). Unknown names are rejected rather than silently running
nothing. Use it when iterating on one failing path — every request costs reputation with these
banks, so a re-test should not re-fetch what already works. `--force` additionally re-fetches
documents the ledger has already recorded.

`--capture` writes every API request/response plus a screenshot per step to
`cfraser/santander-captures/<timestamp>/`, and keeps downloads **out** of the inbox — use it after
any bank UI change to see what actually happened.

## Daily schedule (LaunchAgent)

`daily-run.sh` is the unattended sequence: fetch Santander → `import:cfraser-inbox` →
`import:santander-movements` → `import:santander-statements`. Each step reports pass/fail and the
exit status is the number of failures, so one bank being down does not block the rest.

```bash
cp scraper/com.user.nw-tracker-daily.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.nw-tracker-daily.plist
launchctl kickstart -p gui/$(id -u)/com.user.nw-tracker-daily   # run once, now
launchctl bootout gui/$(id -u)/com.user.nw-tracker-daily        # remove
```

Runs at **22:00** — late enough for the day's movements to post, early enough to miss the bank's
nightly maintenance window. It **must** be a LaunchAgent in the logged-in GUI session (a
LaunchDaemon has no window server, and headless Chrome is blocked). Log: `cfraser/daily-run.log`.
Rehearse without touching the banks: `scraper/daily-run.sh --dry-run`.

A separate scheduled task drops the Lider BCI «últimos movimientos» CSV into `cfraser/inbox/`
around 08:00; the inbox step picks it up (`npm run import:lider-movements` standalone).

Every run writes an app message: a plain `log` when all steps passed, a **`notification`** (badged
unread in the app) plus a macOS alert when any step failed. The message body names each step, its
duration, and — this is the part a per-run status cannot tell you — how long it has been since the
last *successful* run, so a night the agent never fired is visible too.

## Hourly e-mail poll (LaunchAgent)

`email-run.sh` polls Gmail at **:30 past every hour** — `fetch:santander-docs`,
`fetch:lider-boletas`, `fetch:emails` — and applies the cheap e-mail-native imports when a fetch
staged something new that hour (`import:lider-boletas`, `import:santander-receipts`,
`import:fintual-emails`). Everything else stays nightly: the bank web session, the inbox/CC
pipeline, Racional, statement JSONs. The nightly run is also the retry backstop for anything
staged here but not imported.

```bash
cp scraper/com.user.nw-tracker-email-hourly.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.user.nw-tracker-email-hourly.plist
launchctl kickstart -p gui/$(id -u)/com.user.nw-tracker-email-hourly   # run once, now
launchctl bootout gui/$(id -u)/com.user.nw-tracker-email-hourly        # remove
```

Log: `cfraser/email-run.log` (self-rotates at 5 MB). A quiet hour records nothing; a run with
activity or a failure writes an «Hourly e-mail poll» app message via `record:email-run` — never
the daily titles, whose presence would make the 22:00 scheduled run skip itself for the day. Only
the first failure of the Chile day badges as a notification; there is no macOS alert (the nightly
run executes the same e-mail steps and remains the alerting authority). The script skips the hour
outright while `daily-run.sh` is running (shared document ledger / watermark / DB, no locks).

## Broker e-mail (the change detector)

```bash
# cfraser/email-fetch.json → { "address": "you@gmail.com", "keychain_service": "nw-tracker-gmail" }
# App password, NOT the account password — needs 2FA on the Google account:
#   https://myaccount.google.com/apppasswords
security add-generic-password -s nw-tracker-gmail -a "you@gmail.com" -w

npm run fetch:emails                  # broker mail since the watermark → cfraser/broker-emails/
npm run check:broker-emails           # classify + decide what needs a browser
```

Reading mail costs no bank session, no 2FA and no reputation, so it runs first and decides
whether any browser opens at all. It fetches envelopes plus a short text preview only — never
attachments, never the 30KB HTML bodies, which carry nothing the subject lacks.

**Complete vs nudge.** Fintual describes its movements fully in the subject line — amount *and*
share count (`Invertiste US $1,67 dólares en 0,002152366 acciones de …`), so nothing needs
fetching. Racional's purchase mails are complete too, and its `Agregaste USD $5.344,04 a tu
Billetera` is the CLP→USD conversion its own movements list never shows. But its dividend mail
only says money arrived — instrument, no amount. That is a **nudge**: proof something happened,
and the only reason to open the browser. `check:broker-emails` writes
`cfraser/.broker-email-decision.json`, and the daily run fetches Racional only when that names
it. Newsletters, login alerts and monthly summaries never count.

## Racional

```bash
# cfraser/racional-fetch.json → { "email": "you@example.com", "keychain_service": "nw-tracker-racional" }
security add-generic-password -s nw-tracker-racional -a "you@example.com" -w

npm run fetch:racional -- --capture            # first, supervised run
npm run fetch:racional                         # normal run → cfraser/racional-movements/
npm run import:racional-movements              # report only
npm run import:racional-movements -- --apply   # write
```

Signs in with an **e-mail, not a RUT** — the only bank here that does.

**Holdings and movements come from different places**, which shapes everything else:

- holdings/cash → `GET api.racional.cl/positions` (+ `/positions/buying-power`), clean JSON the
  recorder captures like any XHR;
- movements → **pushed over a Firestore realtime channel**, so there is no XHR to intercept. They
  are read from the rendered list (`app-investment-movement` rows) plus, for trades, the detail
  view — which carries units (8 decimals), price per share, commission and the order id.

Reading movements from the DOM is a deliberate trade-off: more fragile than an API, but the
alternative is reimplementing Firestore auth and channel framing for the same data.

**The crawl is incremental.** The list is newest-first, so the fetcher scrolls only until it meets
the last movement the importer recorded (`cfraser/.racional-import-state.json`, written on
`--apply`) and then stops — a quiet day loads one screen and opens zero detail pages. With no
watermark it walks the whole list once.

Cash **deposits and withdrawals are reported but never written**: their counterpart is a real bank
movement that arrives through the checking importer, and inventing that leg here would double-count
it. Link them in `/panel/mirror-pairs`, as with every other historical transfer.

## Constraints worth knowing

- **Headless does not work — use `--background` instead.** Santander's edge serves a fake "Revisa tu
  conexión a internet" page to headless Chrome. Probed 2026-08-04, all three variants:

  | Mode | Result |
  |------|--------|
  | `headless: true` | blocked |
  | `--headless=new` | blocked |
  | headed, window off-screen | **real site served** |

  So `--background` runs a normally-rendering Chrome parked at `--window-position=-3000,-3000`:
  invisible in practice, indistinguishable from a real browser to the bank. Scheduling still needs a
  **LaunchAgent in the logged-in GUI session** (a LaunchDaemon has no window server). The run fails
  with an explicit message if it ever hits the block page.
- **Santander login must start at the public homepage**, not at the login-frame URL. That frame is
  built to be *embedded*; loading it top-level makes its auth call fail with
  `403 Forbidden` on `…/party_auth_dss/v1/oauth2/token` (seen 2026-08-05 — the direct URL had
  worked until then). The flow is: `banco.santander.cl` → dismiss the notice → click Ingresar →
  fill inside `#login-frame` → the window redirects to `mibanco.santander.cl`.
- **The homepage ships in more than one markup variant.** The Ingresar control appeared as
  `a.btn-ingresar` (aria "Abrir panel de ingreso") and, minutes later on the same URL, with generic
  classes and aria "Ingresar al sitio privado" — and it hydrates late, so it can be absent from a
  DOM snapshot taken seconds after load. The selector matches either variant and relies on
  Playwright's auto-waiting rather than a fixed delay.
- **Chrome does not advertise automation, and runs are rate-limited.** Playwright drives Chrome over
  CDP, which sets `navigator.webdriver = true`; both banks read it, and it follows the whole browser
  instance (a hand-opened tab in the same window was refused too — Santander answered the auth call
  with `403`, Cloudflare escalated Lider's Turnstile from auto-pass to an interactive challenge).
  `browser.ts` drops `--enable-automation` and disables the `AutomationControlled` blink feature
  (verified: `navigator.webdriver === false`).

  This is paired with a rate limit on purpose. The intended pattern is **one crawl a day** — no more
  traffic than opening the site by hand — and the escalation followed a burst of development runs in
  a single hour, not that pattern. `runGuard.ts` refuses a second run against the same bank within
  **30 minutes** (`--min-interval=N` to change, `--force` to override, which is logged); the
  timestamp is recorded on *attempt*, since a failed run still sent traffic.
- **Chrome's password manager is disabled for this profile.** Once Chrome saves the bank login it
  autofills the form on later runs, and `fill()` on a non-empty masked RUT field merges the two
  values into an invalid RUT (`12.345.678-5` + typed → `1.234.567.851-8`) that fails login with no
  useful error. `browser.ts` turns off the credential service, and `login.ts` clears each field
  before typing and verifies what landed (RUT compared without separators, password by length only).
- **Two success codes per response.** `METADATA.STATUS` is the gateway's; the backend's own result is
  in `DATA.Informacion.Codigo` / `INFO.CODERR`. A backend timeout returns HTTP 200 + `STATUS: "0"` +
  `Codigo: "16"` — `assertApiOk` checks both, so a timeout can't pass as success.
- **The statement PDF is base64 in JSON** (`estadoDeCuenta` → `DATA.imgNbs64`), not a file download,
  so the fetcher writes it as `80_1_<account>_<YYYYMMDD>.pdf` — the shape the inbox organizer parses.
- **`estadoCuentaNacional` is the statement as structured JSON**, saved to
  `cfraser/santander-statement-json/` alongside the PDF. It is mainframe output: amounts are
  zero-padded implied-decimal strings (`"00000002368"` = 2.368), dates are ISO, and `Pan` gives
  `origin_card_last4` per line for free. Field-mapped against the parser's CSV columns, it covers
  nearly all of them — installments included (`NumeroCuotas`/`TotalCuotas`/`MontoCuota`/`TipoCuota`/
  `TasaCompraCuotas`) — plus header figures the PDF parser never extracts (`PagoMinimo`, `CupoPesos`/
  `CupoDisponible`, `SaldoCapitalCuota`, `CuotasMes1-4`). Known gaps: no `posting_date`, and no
  foreign-currency fields (this is the *national* endpoint; the USD sibling is captured by the
  currency walk on the billed view).
- **Monthly documents are fetched once, then retried only while genuinely due.**
  `documentLedger.ts` records which periods have been fetched (`cfraser/.scraper-documents.json`).
  The cartola for the last closed month becomes due the day that month ends, is retried once a day
  until the bank publishes it, and is never requested again once saved; card statements are keyed per
  facturación and currency. The ledger exists because the inbox can't answer the question —
  `import:cfraser-inbox` moves files out to their archive directories as soon as they import. The
  statement JSON is still saved every run, since the page fetches it anyway.
- **Both sources are kept so they can check each other.** Two independent derivations of the same
  statement is the house convention (AGENTS.md: reconciling two sources should throw on mismatch),
  and it is what decides which one can lead — per-line sets and section totals computed from the
  JSON versus the PDF parse, alarming on divergence.
- **USD is a separate call.** Each currency is its own `consultaUltimosMovimientos`
  (`Entrada.Moneda`), reached by clicking the "Dólares" tab; the swiper alone only ever yields CLP.
- **Downloads keep the bank's filenames.** `import:cfraser-inbox` identifies documents by them
  (`80_<seq>_<account>_YYYYMMDD.pdf` = card statement, `1_…_CC.pdf` = cuenta corriente cartola).
  Never rename on the way in.
- **The profile is persistent** (`cfraser/.browser-profile-santander/`) so cookies and device trust
  survive between nightly runs. Delete it to start clean.
- The fetcher does **not** parse amounts. It stores `MatrizMovimientos` rows verbatim (minus the
  `SALDO INICIAL` row, which is the previous period's billed total) in
  `cfraser/santander-movements/`; normalization belongs to the importer, against real captured data.

## Lider BCI

Login is RUT + "Clave de internet" behind a **Cloudflare Turnstile** check. The login waits for the
hidden `cf-turnstile-response` input to receive a token rather than waiting on the submit button —
that distinguishes "the bot check failed" from "the form is incomplete", and the former is this
bank's most likely failure. The persistent per-bank Chrome profile is what lets Cloudflare recognise
a returning browser; if Turnstile ever refuses, run once with a visible window (no `--background`).

Its API hosts are not known yet, so the recorder captures **every XHR/fetch** for this bank instead
of one host, and the steps navigate and record rather than parse — the first capture run is what
reveals the endpoints. Click path: homepage "últimos movimientos" → "Ver más movimientos" →
`Nacionales` (CLP) / `Internacionales` (USD) tabs → "Descargar estado de cuenta".

## Layout

| Path | Role |
|------|------|
| `src/main.ts` | CLI |
| `src/santander/run.ts` | orchestrates the four steps; each reports independently |
| `src/santander/login.ts` | RUT + Clave Digital, bot-block detection, SPA hash routing |
| `src/santander/cards.ts` | card movements (swiper walk) + statement PDFs |
| `src/santander/checking.ts` | cuenta corriente movements `.xlsx` + cartola |
| `src/capture.ts` | API recorder / screenshots |
| `src/keychain.ts` | reads the clave from the macOS Keychain |
