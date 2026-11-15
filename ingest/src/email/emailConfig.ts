/**
 * The mailbox every IMAP reader signs in to: address, host and the Keychain item holding the app
 * password (`cfraser/email-fetch.json`). A leaf, so the session helper and the fetchers both read it.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "../paths.js";

export const BROKER_EMAIL_KEYCHAIN_SERVICE = "nw-tracker-gmail";

export type BrokerEmailConfig = {
  /** Gmail address; also the Keychain account for the app password. */
  address: string;
  keychain_service: string;
  host: string;
  port: number;
};

export function resolveBrokerEmailConfigPath(): string {
  return path.join(resolveCfraserDir(), "email-fetch.json");
}

export function loadBrokerEmailConfig(): BrokerEmailConfig {
  const file = resolveBrokerEmailConfigPath();
  if (!fs.existsSync(file)) {
    throw new Error(
      `Missing ${file}. Create it with:\n` +
        `{\n  "address": "you@gmail.com",\n  "keychain_service": "${BROKER_EMAIL_KEYCHAIN_SERVICE}"\n}\n\n` +
        `Then store a Gmail APP PASSWORD (not the account password — needs 2FA enabled on the\n` +
        `Google account, https://myaccount.google.com/apppasswords):\n` +
        `  security add-generic-password -s ${BROKER_EMAIL_KEYCHAIN_SERVICE} -a "you@gmail.com" -w`,
    );
  }
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<BrokerEmailConfig>;
  const address = String(raw.address ?? "").trim();
  if (!address) throw new Error(`${file} is missing "address".`);
  return {
    address,
    keychain_service: String(raw.keychain_service ?? BROKER_EMAIL_KEYCHAIN_SERVICE).trim(),
    host: String(raw.host ?? "imap.gmail.com").trim(),
    port: Number(raw.port ?? 993),
  };
}
