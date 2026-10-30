/**
 * One Gmail IMAP session, opened again when the connection drops.
 *
 * Gmail resets a connection whose socket went quiet — on 2026-10-29 the Mac slept on battery,
 * waking ~45 s every five minutes, and every evening run lost one fetch to `read ECONNRESET`,
 * `Socket timeout` or `Connection not available`. imapflow also emits those as an `error` event,
 * which crashed the process when nobody listened. Here the event is listened to, and a session
 * that fails at the connection is run again from the start after a pause, twice at most.
 *
 * Running a session again must be safe, and every fetcher's is: each document is written and
 * recorded in the document ledger before the next one is read (a rerun skips it), and the
 * read-only fetchers rebuild their list from scratch at the start of `run`. An error that is not
 * the connection's (a wrong password, a template the fetcher refuses) is thrown at once.
 */
import { ImapFlow } from "imapflow";
import { readKeychainSecret } from "../keychain.js";
import { log } from "../log.js";
import { loadBrokerEmailConfig } from "./fetch.js";

/** Pauses before the second and third attempt. Timers stall while the Mac sleeps, so a pause is awake time. */
export const IMAP_RETRY_DELAYS_MS = [15_000, 60_000];

const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ETIMEOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
  "NoConnection",
  "EConnectionClosed",
  "GREETING_TIMEOUT",
  "UPGRADE_TIMEOUT",
]);

/** True for a failure of the connection itself, never for an answer the server gave. */
export function isImapConnectionError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; serverResponseCode?: unknown };
  // A refused login carries the server's own code (AUTHENTICATIONFAILED): trying again cannot help.
  if (e.serverResponseCode != null) return false;
  return typeof e.code === "string" && CONNECTION_ERROR_CODES.has(e.code);
}

/** Run `attempt` again after each delay while it fails at the connection. */
export async function retryOnConnectionError<T>(
  label: string,
  attempt: (n: number) => Promise<T>,
  opts?: { delaysMs?: number[]; sleep?: (ms: number) => Promise<void> }
): Promise<T> {
  const delays = opts?.delaysMs ?? IMAP_RETRY_DELAYS_MS;
  const sleep = opts?.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let n = 1; ; n++) {
    try {
      return await attempt(n);
    } catch (err) {
      const delay = delays[n - 1];
      if (delay == null || !isImapConnectionError(err)) throw err;
      const code = (err as { code: string }).code;
      log(`e-mail: ${label} — connection lost (${code}), trying again in ${Math.round(delay / 1000)} s (attempt ${n + 1} of ${delays.length + 1})`);
      await sleep(delay);
    }
  }
}

/** Open a session on the configured Gmail account, run `run`, log out; again on a dropped connection. */
export async function withImapSession<T>(label: string, run: (client: ImapFlow) => Promise<T>): Promise<T> {
  const config = loadBrokerEmailConfig();
  const password = readKeychainSecret(config.keychain_service, config.address);
  return retryOnConnectionError(label, async () => {
    const client = new ImapFlow({
      host: config.host,
      port: config.port,
      secure: true,
      auth: { user: config.address, pass: password },
      logger: false,
    });
    // The pending command rejects with the same failure; the event only needs a listener.
    client.on("error", () => undefined);
    await client.connect();
    try {
      return await run(client);
    } finally {
      await client.logout().catch(() => undefined);
    }
  });
}
