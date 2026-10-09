/**
 * Record a card payment entered by hand — paid at a branch, from a dollar account, with no
 * receipt mail (`POST /api/ingest/tasks/cc_manual_payment`, server `ccManualPayments.ts`).
 *
 *   npm run cc:manual-payment -w nw-tracker-ingest -- --from=<account id> --card=<card account id> \
 *     --amount=<n> --currency=clp|usd --date=YYYY-MM-DD [--transfer=<movement id>] [--note=<text>]
 *
 * `--transfer` adopts an existing `pago_tarjeta` transfer instead of writing one. Running it twice
 * changes nothing. Exit status: 1 when the server refuses or is down, 2 on bad arguments.
 */
import type { CcManualPaymentRequest } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "./serverApi.js";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

function positiveInt(name: string, raw: string | undefined): number | null {
  if (raw == null) return null;
  if (!/^\d+$/.test(raw) || Number(raw) <= 0) throw new Error(`--${name} must be a positive integer, got ${raw}`);
  return Number(raw);
}

function parseRequest(): CcManualPaymentRequest {
  const from = positiveInt("from", arg("from"));
  const card = positiveInt("card", arg("card"));
  const amountRaw = arg("amount");
  const currency = arg("currency");
  const date = arg("date");
  if (from == null || card == null || amountRaw == null || currency == null || date == null) {
    throw new Error("--from, --card, --amount, --currency and --date are required");
  }
  // The CLI's own format (period decimals), not a typed Chilean number.
  if (!/^\d+(\.\d{1,2})?$/.test(amountRaw)) throw new Error(`--amount must look like 250.00, got ${amountRaw}`);
  if (currency !== "clp" && currency !== "usd") throw new Error(`--currency must be clp or usd, got ${currency}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`--date must be YYYY-MM-DD, got ${date}`);
  return {
    from_account_id: from,
    card_account_id: card,
    amount: Number(amountRaw),
    currency,
    paid_on: date,
    note: arg("note") ?? null,
    existing_transfer_movement_id: positiveInt("transfer", arg("transfer")),
  };
}

async function main(): Promise<number> {
  let request: CcManualPaymentRequest;
  try {
    request = parseRequest();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
  try {
    const result = await ingestClient().recordManualCardPayment(request);
    console.log(`${result.status}: ${result.detail}`);
    return 0;
  } catch (err) {
    console.error(`FAILED — ${describeIngestFailure(err)}`);
    return 1;
  }
}

process.exitCode = await main();
