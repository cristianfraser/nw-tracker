/**
 * In-app login for the hosted demo. Replaces the old HTTP Basic prompt: the client renders a
 * `/login` page that POSTs here; on success we set a signed HttpOnly session cookie that the
 * shared-password middleware (httpSecurity.ts) verifies on every `/api/*` request.
 *
 * These three routes are exempt from that middleware (see `isAuthExemptPath`), so they must
 * not assume an authenticated session. Local personal mode (no `AUTH_PASSWORD`) reports
 * `auth_required: false` and rejects login attempts.
 */
import express from "express";
import {
  SESSION_COOKIE,
  isValidDemoAuthEmail,
  issueSessionToken,
  readCookie,
  recordDemoAuthLogin,
  sharedAuthPasswordFromEnv,
  verifyDemoPassword,
  verifySessionToken,
} from "../httpSecurity.js";
import { demoModeEnabled } from "../demoMode.js";

function authRequired(): boolean {
  return sharedAuthPasswordFromEnv() != null;
}

/**
 * Public demo-password shown/prefilled on the login page. The shared password is
 * intentionally public in demo mode (recruiter self-serve), so we surface it directly.
 * Gated on `DEMO_MODE` so a non-demo deployment that happens to set `AUTH_PASSWORD`
 * (real data behind a shared password) never leaks it on the unauthenticated status route.
 */
function passwordHint(): string | null {
  return demoModeEnabled() ? sharedAuthPasswordFromEnv() : null;
}

function sessionCookieOptions(): express.CookieOptions {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

export function registerAuthRoutes(app: express.Express): void {
  app.get("/api/auth/status", (req, res) => {
    const session = verifySessionToken(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.json({
      auth_required: authRequired(),
      authenticated: session != null,
      email: session?.email ?? null,
      password_hint: passwordHint(),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    if (!authRequired()) {
      res.status(400).json({ error: "auth disabled" });
      return;
    }
    const email = typeof req.body?.email === "string" ? req.body.email.trim() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!isValidDemoAuthEmail(email)) {
      res.status(401).json({ error: "invalid_email" });
      return;
    }
    if (!verifyDemoPassword(password)) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }
    recordDemoAuthLogin(email);
    res.cookie(SESSION_COOKIE, issueSessionToken(email), sessionCookieOptions());
    res.json({ ok: true, email: email.toLowerCase() });
  });

  app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  });
}
