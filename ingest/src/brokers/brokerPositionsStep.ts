/**
 * Read a broker's positions and send them (`broker.positions`), printing what the server did. One
 * reader per broker; the contract and everything after it are broker-neutral. Returns a problem
 * line when the read or the send failed, null otherwise.
 */
import { brokerPositionsKind, type BrokerPositionsApplyDetails, type BrokerPositionsPayload } from "nw-tracker-contracts";
import { describeIngestFailure, ingestClient } from "../serverApi.js";
import { fetchFintualPositions } from "../fintual/positions.js";

type BrokerWithPositions = BrokerPositionsPayload["broker"];

const READERS: Partial<Record<BrokerWithPositions, () => Promise<BrokerPositionsPayload["positions"]>>> = {
  fintual: fetchFintualPositions,
};

export async function sendBrokerPositions(broker: BrokerWithPositions, apply: boolean): Promise<string | null> {
  const read = READERS[broker];
  if (!read) return null;
  const readAt = new Date().toISOString();
  let positions: BrokerPositionsPayload["positions"];
  try {
    positions = await read();
  } catch (err) {
    const line = `${broker} positions NOT read — ${err instanceof Error ? err.message : String(err)}`;
    console.error(line);
    return line;
  }
  let details: BrokerPositionsApplyDetails;
  try {
    const payload = brokerPositionsKind.payload.parse({ broker, read_at: readAt, positions });
    const result = await ingestClient().send(
      brokerPositionsKind,
      payload,
      { channel: "web_session", ref: `${broker}-positions-${readAt}`, fetched_at: readAt },
      { dryRun: !apply }
    );
    details = result.details as BrokerPositionsApplyDetails;
  } catch (err) {
    const line = `${broker} positions NOT sent — ${describeIngestFailure(err)}`;
    console.error(line);
    return line;
  }
  console.log(`${broker} positions: ${positions.map((p) => `${p.symbol} ${p.shares}`).join(", ") || "none"}`);
  if (details.new_symbols.length > 0) console.log(`  new lines: ${details.new_symbols.join(", ")}`);
  if (details.registered.length > 0) {
    console.log(`  ${apply ? "registered" : "would register"}: ${details.registered.join(", ")}`);
  }
  for (const u of details.unregistered) console.error(`  could not register ${u.symbol}: ${u.error}`);
  return details.unregistered.length > 0
    ? `${broker} positions: could not register ${details.unregistered.map((u) => `${u.symbol} (${u.error})`).join("; ")}`
    : null;
}
