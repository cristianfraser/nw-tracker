import fs from "node:fs";
import path from "node:path";
import { readKeychainItemModifiedAt } from "../keychain.js";
import { log } from "../log.js";
import { resolveCfraserDir } from "../paths.js";

/**
 * A credentials rejection is remembered between runs.
 *
 * When the bank answers the login with «Alguno de los datos ingresados es incorrecto» the stored
 * Clave Digital no longer matches (2026-09-12 → 09-14: three nightly attempts in a row, the Keychain
 * item unchanged since 08-05, the same clave having logged in fine on 09-11 22:38). An unattended
 * runner that keeps presenting a wrong clave every night is exactly how a bank ends up blocking it,
 * so the rejection latches further logins OFF. The latch is not a silent skip: every run still fails
 * the Santander step with a message naming the rejection and the fix, so the nightly notification
 * keeps firing until someone acts. It clears itself once the Keychain item is modified after the
 * rejection (the only fix that can help), on a successful login, or for one run with `--force`.
 */
type LoginLatch = { at: string; message: string };

export function loginLatchPath(): string {
  return path.join(resolveCfraserDir(), ".santander-login-rejected.json");
}

function readLatch(): LoginLatch | null {
  const file = loginLatchPath();
  if (!fs.existsSync(file)) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<LoginLatch>;
  if (typeof parsed.at !== "string" || Number.isNaN(Date.parse(parsed.at))) {
    throw new Error(`${file} is not a login latch (expected {"at": ISO date, "message": string}); delete it if stale.`);
  }
  return { at: parsed.at, message: String(parsed.message ?? "") };
}

export function recordCredentialsRejected(message: string): void {
  const latch: LoginLatch = { at: new Date().toISOString(), message };
  fs.writeFileSync(loginLatchPath(), `${JSON.stringify(latch, null, 2)}\n`);
  log(`the bank rejected the credentials — logins are latched off until the Keychain item is updated (${loginLatchPath()})`);
}

export function clearLoginLatch(reason: string): void {
  const file = loginLatchPath();
  if (!fs.existsSync(file)) return;
  fs.unlinkSync(file);
  log(`login latch cleared — ${reason}`);
}

/** Throw before any browser opens when the last login was a credentials rejection (see above). */
export function assertLoginNotLatched(keychainService: string, account: string, force: boolean): void {
  const latch = readLatch();
  if (!latch) return;
  const modified = readKeychainItemModifiedAt(keychainService, account);
  if (modified && modified.getTime() > Date.parse(latch.at)) {
    clearLoginLatch(`the Keychain item was updated at ${modified.toISOString()}, after the rejection of ${latch.at}`);
    return;
  }
  if (force) {
    log(`--force: logging in despite the credentials rejection of ${latch.at}`);
    return;
  }
  throw new Error(
    `Not logging in: the bank rejected the RUT/Clave Digital on ${latch.at} («${latch.message}»), and the ` +
      `Keychain item has not changed since. Presenting a wrong clave every night risks the bank blocking it. ` +
      `Log in by hand to confirm the current clave, store it with ` +
      `\`security add-generic-password -U -s ${keychainService} -a "${account}" -w\` and the latch clears itself ` +
      `on the next run; \`--force\` tries once regardless.`,
  );
}
