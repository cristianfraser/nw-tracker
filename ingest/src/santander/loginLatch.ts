import { loginLatch } from "../loginLatch.js";

/**
 * Santander's credentials latch (`../loginLatch.ts`): «Alguno de los datos ingresados es
 * incorrecto» latches further logins off until the Keychain item changes.
 */
export const santanderLoginLatch = loginLatch({
  fileName: ".santander-login-rejected.json",
  site: "the bank",
  credentials: "RUT/Clave Digital",
});

export function loginLatchPath(): string {
  return santanderLoginLatch.path();
}

export function recordCredentialsRejected(message: string): void {
  santanderLoginLatch.recordCredentialsRejected(message);
}

export function clearLoginLatch(reason: string): void {
  santanderLoginLatch.clear(reason);
}

/** Throw before any browser opens when the last login was a credentials rejection. */
export function assertLoginNotLatched(keychainService: string, account: string, force: boolean): void {
  santanderLoginLatch.assertNotLatched(keychainService, account, force);
}
