import fs from "node:fs";
import path from "node:path";
import { readKeychainItemModifiedAt } from "./keychain.js";
import { log } from "./log.js";
import { resolveCfraserDir } from "./paths.js";

/**
 * A credentials rejection is remembered between runs, per site.
 *
 * When a site answers the login with «the data is wrong» the stored clave no longer matches
 * (Santander, 2026-09-12 → 09-14: three nightly attempts in a row, the Keychain item unchanged
 * since 08-05, the same clave having logged in fine on 09-11 22:38). An unattended runner that
 * keeps presenting a wrong clave every night is exactly how a bank ends up blocking it, so the
 * rejection latches further logins OFF. The latch is not a silent skip: every run still fails the
 * step with a message naming the rejection and the fix, so the nightly notification keeps firing
 * until someone acts. It clears itself once the Keychain item is modified after the rejection (the
 * only fix that can help), on a successful login, or for one run with `--force`.
 */
type LatchRecord = { at: string; message: string };

export type LoginLatchSpec = {
  /** File under `cfraser/`, e.g. `.santander-login-rejected.json`. */
  fileName: string;
  /** Who rejected the login, as the messages say it («the bank», «MetLife»). */
  site: string;
  /** What was rejected («RUT/Clave Digital»). */
  credentials: string;
};

export type LoginLatch = {
  path(): string;
  /** Whether a rejection is on file (the runner's veto reads it without the Keychain). */
  isLatched(): boolean;
  recordCredentialsRejected(message: string): void;
  clear(reason: string): void;
  /** Throw before any browser opens when the last login was a credentials rejection (see above). */
  assertNotLatched(keychainService: string, account: string, force: boolean, readModifiedAt?: (service: string, account: string) => Date | null): void;
};

export function loginLatch(spec: LoginLatchSpec): LoginLatch {
  const file = () => path.join(resolveCfraserDir(), spec.fileName);

  function read(): LatchRecord | null {
    const f = file();
    if (!fs.existsSync(f)) return null;
    const parsed = JSON.parse(fs.readFileSync(f, "utf8")) as Partial<LatchRecord>;
    if (typeof parsed.at !== "string" || Number.isNaN(Date.parse(parsed.at))) {
      throw new Error(`${f} is not a login latch (expected {"at": ISO date, "message": string}); delete it if stale.`);
    }
    return { at: parsed.at, message: String(parsed.message ?? "") };
  }

  function clear(reason: string): void {
    const f = file();
    if (!fs.existsSync(f)) return;
    fs.unlinkSync(f);
    log(`login latch cleared — ${reason}`);
  }

  return {
    path: file,
    isLatched: () => fs.existsSync(file()),
    recordCredentialsRejected(message) {
      const latch: LatchRecord = { at: new Date().toISOString(), message };
      fs.writeFileSync(file(), `${JSON.stringify(latch, null, 2)}\n`);
      log(`${spec.site} rejected the credentials — logins are latched off until the Keychain item is updated (${file()})`);
    },
    clear,
    assertNotLatched(keychainService, account, force, readModifiedAt = readKeychainItemModifiedAt) {
      const latch = read();
      if (!latch) return;
      const modified = readModifiedAt(keychainService, account);
      if (modified && modified.getTime() > Date.parse(latch.at)) {
        clear(`the Keychain item was updated at ${modified.toISOString()}, after the rejection of ${latch.at}`);
        return;
      }
      if (force) {
        log(`--force: logging in despite the credentials rejection of ${latch.at}`);
        return;
      }
      throw new Error(
        `Not logging in: ${spec.site} rejected the ${spec.credentials} on ${latch.at} («${latch.message}»), and the ` +
          `Keychain item has not changed since. Presenting a wrong clave every night risks ${spec.site} blocking it. ` +
          `Log in by hand to confirm the current clave, store it with ` +
          `\`security add-generic-password -U -s ${keychainService} -a "${account}" -w\` and the latch clears itself ` +
          `on the next run; \`--force\` tries once regardless.`,
      );
    },
  };
}
