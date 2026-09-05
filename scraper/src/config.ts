import fs from "node:fs";
import path from "node:path";
import { resolveCfraserDir } from "./paths.js";

/**
 * Personal identifiers live in gitignored `cfraser/`, never in the repo — same convention as
 * `cfraser/organize-identifiers.json`. The RUT is both the login username and the Keychain account.
 */
export type BankConfig = {
  /** Login RUT, e.g. "12.345.678-5" — empty for banks that sign in with an email. */
  rut: string;
  /** Login e-mail — empty for banks that sign in with a RUT. */
  email: string;
  /** Keychain service holding the password (default `nw-tracker-<bank>`). */
  keychain_service: string;
  /** Login username AND Keychain account: the RUT or the e-mail, per bank. */
  loginAccount: string;
};

export type BankName = "santander" | "racional";

/**
 * Which identifier each bank signs in with. Santander uses the RUT; Racional is a
 * brokerage app and uses an e-mail, so the field cannot be assumed.
 */
export const LOGIN_IDENTIFIER: Record<BankName, "rut" | "email"> = {
  santander: "rut",
  racional: "email",
} as const;

export function resolveBankConfigPath(bank: BankName): string {
  return path.join(resolveCfraserDir(), `${bank}-fetch.json`);
}

export function loadBankConfig(bank: BankName): BankConfig {
  const file = resolveBankConfigPath(bank);
  const kind = LOGIN_IDENTIFIER[bank];
  const sample =
    kind === "email"
      ? `{\n  "email": "you@example.com",\n  "keychain_service": "nw-tracker-${bank}"\n}`
      : `{\n  "rut": "12.345.678-9",\n  "keychain_service": "nw-tracker-${bank}"\n}`;
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Create it with:\n${sample}`);
  }
  const raw: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
  if (typeof raw !== "object" || raw === null) throw new Error(`${file} must contain a JSON object.`);
  const cfg = raw as Partial<BankConfig>;
  const rut = String(cfg.rut ?? "").trim();
  const email = String(cfg.email ?? "").trim();
  const loginAccount = kind === "email" ? email : rut;
  if (!loginAccount) {
    throw new Error(`${file} is missing "${kind}". Expected shape:\n${sample}`);
  }
  const keychain_service = String(cfg.keychain_service ?? `nw-tracker-${bank}`).trim();
  assertKeychainServiceBelongsToBank(bank, keychain_service, file);
  return { rut, email, keychain_service, loginAccount };
}

/**
 * Reject a config pointing at ANOTHER bank's Keychain item.
 *
 * These files get created by copying a sibling, and the service name is the easiest field to
 * forget (it happened on the first Racional run, which went looking for `nw-tracker-lider`).
 * A missing item merely fails, but a *valid* wrong one is worse: the run would try to log in
 * with another bank's password, and repeated failures are how accounts get locked. A custom
 * name that does not look like another bank's is left alone.
 */
function assertKeychainServiceBelongsToBank(
  bank: BankName,
  keychainService: string,
  file: string,
): void {
  const otherBanks = (Object.keys(LOGIN_IDENTIFIER) as BankName[]).filter((b) => b !== bank);
  const claimedBy = otherBanks.find((b) => keychainService === `nw-tracker-${b}`);
  if (!claimedBy) return;
  throw new Error(
    `${file} sets "keychain_service": "${keychainService}", which is ${claimedBy}'s item — ` +
      `signing in to ${bank} with ${claimedBy}'s password would just fail, and repeated ` +
      `failures can lock the account. Use "nw-tracker-${bank}" (or remove the field to default to it).`,
  );
}
