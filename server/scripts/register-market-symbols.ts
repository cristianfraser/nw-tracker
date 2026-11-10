/**
 * Backfill the instrument registry (`market_symbols`, migration 305): register every ticker the
 * app prices that has no row, and refresh rows whose facts a price provider now states
 * differently (market kind, quote currency, MIC, display symbol). Report-first: without --apply it
 * prints what it would write and changes nothing.
 *
 *   npm run register:market-symbols -w nw-tracker-server -- [--only=SPY,BTC-USD] [--apply]
 *
 * Provider per ticker: CoinGecko when it knows the symbol (the coins), else Yahoo. Rows declared by
 * the demo generator or a fixture are not re-verified. All or nothing: when a provider cannot
 * classify a ticker, or `registerInstrument` refuses (stored bars in another currency), nothing is
 * written, every offender is named and the exit code is 1. Idempotent: a second run reports
 * «nothing to register».
 *
 * Importing db.ts applies pending migrations to the database it opens (the script needs 305) —
 * intended; point NW_TRACKER_TEST_DB at a copy to rehearse. The deploy agent runs it with --apply
 * after the client build and before the server restart (scripts/server-deploy.sh).
 */
import {
  applyInstrumentRegistrationPlan,
  planInstrumentRegistration,
  type PlannedRegistration,
} from "../src/instrumentRegistrationPlan.js";

function arg(name: string): string | undefined {
  const p = process.argv.find((a) => a.startsWith(`--${name}=`));
  return p ? p.slice(name.length + 3) : undefined;
}

function table(items: PlannedRegistration[]): string {
  const head = ["action", "ticker", "provider", "market", "ccy", "mic", "display", "name", "changes"];
  const rows = items.map((i) => [
    i.action,
    i.ticker,
    i.provider,
    i.facts.market_kind,
    i.facts.quote_currency,
    i.facts.mic ?? "-",
    i.facts.display_symbol,
    i.facts.name ?? "-",
    i.changes.join("; ") || "-",
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c]!.length)));
  const line = (r: string[]) => r.map((v, c) => v.padEnd(widths[c]!)).join("  ").trimEnd();
  return [line(head), ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const onlyArg = arg("only");
  const only = onlyArg ? onlyArg.split(",").map((t) => t.trim()).filter(Boolean) : undefined;
  const plan = await planInstrumentRegistration({ only });
  if (plan.items.length === 0 && plan.failures.length === 0) {
    console.log("nothing to register");
    return;
  }
  if (plan.items.length > 0) console.log(table(plan.items));
  if (plan.failures.length > 0) {
    for (const f of plan.failures) console.error(`FAILED ${f.ticker} (${f.provider}): ${f.error}`);
    console.error("nothing written: fix the failures above and run again");
    process.exit(1);
  }
  if (!apply) {
    console.log(`${plan.items.length} instrument(s) to write; run with --apply`);
    return;
  }
  const refused = applyInstrumentRegistrationPlan(plan);
  if (refused.length > 0) {
    for (const f of refused) console.error(`REFUSED ${f.ticker} (${f.provider}): ${f.error}`);
    console.error("nothing written");
    process.exit(1);
  }
  console.log(`registered ${plan.items.length} instrument(s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
