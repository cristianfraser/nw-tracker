import { execFileSync } from "node:child_process";

/**
 * Read a secret from the macOS Keychain.
 *
 * Store it once (the flagless `-w` prompts, so the password never lands in shell history):
 *   security add-generic-password -s nw-tracker-santander -a "<RUT>" -w
 *
 * The value is passed straight to Playwright's `fill()` and is never logged or written to disk.
 */
export function readKeychainSecret(service: string, account: string): string {
  let out: string;
  try {
    out = execFileSync("security", ["find-generic-password", "-s", service, "-a", account, "-w"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Keychain item not found (service "${service}", account "${account}").\n` +
        `Store it with:\n  security add-generic-password -s ${service} -a "${account}" -w\n` +
        `Underlying error: ${detail}`,
    );
  }
  const secret = out.replace(/\n$/, "");
  if (!secret) throw new Error(`Keychain item "${service}"/"${account}" is empty.`);
  return secret;
}

/**
 * When the Keychain item was last modified — read from its attributes, without `-w`, so the secret
 * itself never leaves the Keychain here. Null when the item is missing or the date cannot be read.
 * `security` prints it as `"mdat"<timedate>=0x… "20260805030915Z\000"`.
 */
export function readKeychainItemModifiedAt(service: string, account: string): Date | null {
  let out: string;
  try {
    out = execFileSync("security", ["find-generic-password", "-s", service, "-a", account], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  const m = /"mdat"<timedate>=\S+\s+"(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z/.exec(out);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}
