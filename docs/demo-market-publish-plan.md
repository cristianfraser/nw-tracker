# The home server publishes the demo's market data (2026-11-09)

## Why

The hosted demo (Render, `render.yaml`) builds its synthetic database at build time, and the first
step of that build fetched the demo's market history from the outside world: Yahoo daily closes
and dividends, Yahoo CLP=X, the Banco Central (dólar observado, EUR, UF, UTM, IPC), AFP UNO's own
API, a committed CSV for Modelo and — since 2026-11-09 — a committed snapshot of the Bolsa de
Santiago's closes, because Render's servers cannot reach the Bolsa nor the Superintendencia de
Pensiones (both answer an HTML wall). Two releases failed at that step on 2026-11-09, each costing a
build. Render's build machines are a bad place to fetch from.

The home server (the always-on primary, which deploys itself from `main`) reaches every source.
So it fetches, and Render only downloads one file.

## What

- **The artifact** (`server/src/demoData/demoMarketArtifact.ts`): gzipped JSON, ~0,3 MB.
  `schema_version` (1), `generated_at`, `complete_through` (the Chile day the history is complete
  through: the publish run's yesterday), the spec it was built for (`demoMarketSpec()`: the window's
  first month, every ticker with its first use, the AFP), and per market table its columns and rows
  as `loadDemoRealMarket` left them: `equity_daily`, `equity_dividends`, `fx_daily`,
  `fx_daily_bcentral`, `eur_daily`, `uf_daily`, `utm_daily`, `ipc_daily`,
  `pension_fund_unit_official`, `fund_unit_daily` (UNO's display series). The list is exhaustive by
  check: the publish script counts every table before and after the loader and fails when anything
  else moved (`assertOnlyMarketTablesChanged`; the change log `mark_input_changes` and the Yahoo fx
  rejection list `fx_daily_yahoo_rejected` are side effects, not exported).
- **The publish** (`server/scripts/publish-demo-market.ts`, `npm run demo:publish-market -w
  nw-tracker-server [-- --upload]`): runs `loadDemoRealMarket` against a scratch SQLite file
  (`server/data/demo-market-publish.db`, deleted first; never the live DB — the loader writes
  through the process's one `db`, which is why it is a script), with the Santiago closes straight
  from the Bolsa (`--santiago=bolsa`, the default here), exports the artifact into
  `server/data/demo-market/` (the `.json.gz` and its header `.meta.json`), reads it back, and with
  `--upload` publishes both.
- **The release** (`server/src/demoMarketRelease.ts`): one GitHub release on the fixed tag
  `demo-market` of `cristianfraser/nw-tracker` («Demo market data», created on first publish at
  `main`, `make_latest: false` so it never shows as the repo's latest release), two assets under
  fixed names, `demo-market.json.gz` and `demo-market.meta.json`. Replacing one: upload under
  `demo-market.next.json.gz`, delete the old asset, rename the new one — a download never sees a
  half-written file and misses the asset only between the delete and the rename.
- **The nightly job** (`server/src/demoMarketPublishJob.ts`, a `ScheduledJob` on the kernel): at
  01:00 Chile (after the evening EOD syncs) it spawns the publish script with `--upload` in a child
  process (env: the scratch DB, `BACKGROUND_JOBS_ENABLED=0`, `DEMO_MODE=0`; 60 min timeout). At boot
  it publishes at once when the last success is older than 20 h — a deploy on every push does not
  republish. A failure retries after 15 and 45 minutes and is a notification («Demo market publish
  failed», with the script's last lines); a success is a log row. State in
  `server/data/.demo-market-publish-state.json`. Enabled by `DEMO_MARKET_PUBLISH_ENABLED` (default on,
  off with `BACKGROUND_JOBS_ENABLED=0`, never on the demo) and a `DEMO_MARKET_PUBLISH_TOKEN` present
  at boot; without the token it logs «not configured» and never arms.
- **The build** (`server/scripts/generate-demo-data.ts --market-asset`, which is now `npm run
  demo:generate`, the command `render.yaml` runs): downloads
  `https://github.com/cristianfraser/nw-tracker/releases/download/demo-market/demo-market.json.gz`
  (no token: the repo is public, and that URL is not counted against the API's unauthenticated rate
  limit, which Render's shared build addresses could exhaust), retried like the other sources, then
  refuses — naming the job — an artifact of another schema version, complete through more than three
  days before the build's yesterday (`DEMO_MARKET_ASSET_MAX_AGE_DAYS`), built for less than the
  build's spec (a later window, a missing ticker, a ticker starting after its first use, no AFP), or
  whose table columns are not this schema's. Then it inserts the rows into the fresh demo DB in one
  transaction and generates the person as before.
- **Before a release** `scripts/release-demo.sh` reads the header asset and refuses when the market
  is older than the build would accept (it replaced the Santiago snapshot check).

Rehearsed 2026-11-09 on the laptop: the publish built a 0,30 MiB artifact through 2026-11-08 (Bolsa
direct, no snapshot); generating from it (`--market-asset-file=`) and generating with
`--real-market --santiago=bolsa` gave identical market tables and valuations, and the same net worth,
US$427.157.

## Modes of `generate-demo-data.ts`

| Flag | Market | Who |
|---|---|---|
| `--market-asset` | the release asset | Render's build (`npm run demo:generate`) |
| `--market-asset-file=<path>` | a local artifact | a rehearsal |
| `--real-market [--santiago=bolsa]` | fetched directly (snapshot for Santiago unless `bolsa`) | rollback, local rehearsal (`npm run demo:generate:fetch`) |
| none | synthetic | offline |

The demo's own boot, which generates only on an empty DB (a local rehearsal), still fetches.

## Credentials the user creates

1. **A fine-grained personal access token** on GitHub: resource owner the account, repository access
   «Only select repositories» → `nw-tracker`, permissions **Contents: Read and write** (releases and
   their assets live under Contents; Metadata: read is added automatically). Any expiry; the job
   notifies on the first failed night after it expires.
2. **On the home server**, put it where the server reads it at boot:
   `DEMO_MARKET_PUBLISH_TOKEN=github_pat_…` in the root `.env` of the checkout
   (`~/…/nw-tracker/.env`, gitignored), or as an `EnvironmentVariables` entry of the installed
   server plist (`~/Library/LaunchAgents/com.user.nw-tracker-server.plist`). Then restart the server
   (`launchctl kickstart -k gui/$(id -u)/com.user.nw-tracker-server`). The first boot publishes at
   once (no state file yet); check `cfraser/server.log` for `demo-market-publish:` and the app's
   messages for «Demo market published».
3. **Publish before releasing** the commit that carries this change: the Render build of that
   commit downloads the asset and fails when there is none. The home server deploys `main` within
   minutes and publishes on boot, so: create the token, push, wait for «Demo market published», then
   `npm run release:demo` (which checks the header asset first).

`BCENTRAL_EMAIL` / `BCENTRAL_PASSWORD` must stay on Render: the build no longer reads them, but the
demo's wake-on-visit syncs (`demoMarketActivity.ts`, the global sync's `sbif_*` sources) append the
days since the build from the Banco Central. The home server's publish reads its own, from its
`.env`.

## Rolling back to fetching on Render

1. In `render.yaml`, change the build's last step to `npm run demo:generate:fetch -w nw-tracker-server`.
2. Refresh the Santiago snapshot from a machine that reaches the Bolsa
   (`npm run demo:refresh-santiago-snapshot -w nw-tracker-server`), commit it: in fetch mode the
   build reads it and refuses one older than a week.
3. Restore the snapshot check in `scripts/release-demo.sh` (git history: commit 6da22346) in place of
   the asset check. Release.

The job keeps publishing harmlessly; turn it off with `DEMO_MARKET_PUBLISH_ENABLED=0` or by removing
the token.

## Releasing from the home server (optional, off by default)

`scripts/server-deploy.sh` can release every healthy deploy of `main` to the demo
(`release_demo_after_deploy`: `scripts/release-demo.sh --yes <sha>`). It is **off** unless the
installed deploy agent's plist sets `NW_DEPLOY_RELEASE_DEMO=1`, because releasing has been the
user's call. It needs a credential that may push `demo` — the deploy key is read-only:

- create a second SSH key on the home server and add it to the repo as a deploy key **with write
  access**, or use a fine-grained token with Contents: write (the publish token would do);
- add a remote using it, e.g. `git remote add demo-push git@github-demo-push:cristianfraser/nw-tracker.git`
  with a `Host github-demo-push` entry in `~/.ssh/config` naming that key;
- set `RELEASE_DEMO_PUSH_REMOTE=demo-push` and `NW_DEPLOY_RELEASE_DEMO=1` in the deploy agent's
  `EnvironmentVariables` (`scripts/install-deploy-agent.sh` writes the plist; add the keys there or
  by hand and reload the agent).

Neither credential can be limited to the `demo` branch by itself; a ruleset on `main` (require pull
requests, or restrict pushes to the user) keeps a leaked key from rewriting `main`. A release the
script refuses (the market asset is stale, not a fast-forward) or a push that fails never undoes the
deploy: it is logged in `cfraser/deploy.log` and raised as «Demo release failed».
