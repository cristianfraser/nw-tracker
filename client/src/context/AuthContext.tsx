import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { api, AUTH_EXPIRED_EVENT } from "../api";
import { readAuthStatusCache, writeAuthStatusCache } from "./authStatusCache";

/**
 * Demo login state. `authRequired` mirrors the server's `AUTH_PASSWORD` env: in local personal
 * mode it is false and the app is never gated (status is forced to `authenticated`). In hosted
 * demo mode the app routes only render once a valid session cookie exists; otherwise the route
 * guard sends the user to the in-app `/login` page.
 *
 * There is no "loading" state: the provider seeds status/authRequired optimistically from the
 * last resolved outcome (`nw:auth-status-v1`) so first paint never waits on `/api/auth/status`.
 * The live response (and the 401 AUTH_EXPIRED_EVENT) corrects a stale seed within one
 * round-trip. No cache (first-ever visit) seeds the login gate — right for a gated deployment's
 * first visitor; a local first visit self-corrects to the app when the status resolves.
 */
export type AuthStatus = "anonymous" | "authenticated";
export type AuthLoginErrorCode = "invalid_email" | "invalid_credentials" | "unknown";
export type AuthLoginResult = { ok: true } | { ok: false; code: AuthLoginErrorCode };

type AuthContextValue = {
  status: AuthStatus;
  authRequired: boolean;
  email: string | null;
  passwordHint: string | null;
  login: (email: string, password: string) => Promise<AuthLoginResult>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

/** The login endpoint returns `{ error: "invalid_email" | "invalid_credentials" }`; `j()` throws
 * with that JSON body as the message. Recover the code so the login page can localize it. */
function parseLoginErrorCode(err: unknown): AuthLoginErrorCode {
  const msg = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(msg) as { error?: string };
    if (parsed?.error === "invalid_email" || parsed?.error === "invalid_credentials") {
      return parsed.error;
    }
  } catch {
    /* not a JSON error body (e.g. network failure) */
  }
  return "unknown";
}

function seedFromCache(): { status: AuthStatus; authRequired: boolean } {
  const cached = readAuthStatusCache();
  if (!cached) return { status: "anonymous", authRequired: true };
  return {
    status: cached.gated ? "anonymous" : "authenticated",
    authRequired: cached.auth_required,
  };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>(() => seedFromCache().status);
  const [authRequired, setAuthRequired] = useState(() => seedFromCache().authRequired);
  const [email, setEmail] = useState<string | null>(null);
  const [passwordHint, setPasswordHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryTimer: number | undefined;
    const attempt = () => {
      api
        .authStatus()
        .then((s) => {
          if (cancelled) return;
          setAuthRequired(s.auth_required);
          setPasswordHint(s.password_hint);
          setEmail(s.email);
          // Local mode (no auth) is never gated; otherwise gate until a valid session exists.
          setStatus(!s.auth_required || s.authenticated ? "authenticated" : "anonymous");
          writeAuthStatusCache({
            auth_required: s.auth_required,
            gated: s.auth_required && !s.authenticated,
          });
        })
        .catch(() => {
          // /api/auth/status is exempt from auth, so a failure here means the API is
          // unreachable (dev server restarting, proxy hiccup). Keep the seeded state — the
          // data queries surface their own API-hint errors — and retry until a response lands.
          if (!cancelled) retryTimer = window.setTimeout(attempt, 3000);
        });
    };
    attempt();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => {
    // A gated /api request returning 401 (session missing/expired) → back to the login gate.
    // Only a gated deployment can 401, so this also corrects an optimistic ungated seed.
    const onExpired = () => {
      setEmail(null);
      setAuthRequired(true);
      setStatus("anonymous");
      writeAuthStatusCache({ auth_required: true, gated: true });
    };
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
  }, []);

  const login = useCallback(async (emailInput: string, password: string): Promise<AuthLoginResult> => {
    try {
      const res = await api.authLogin(emailInput, password);
      setEmail(res.email);
      setAuthRequired(true);
      setStatus("authenticated");
      writeAuthStatusCache({ auth_required: true, gated: false });
      return { ok: true };
    } catch (err) {
      return { ok: false, code: parseLoginErrorCode(err) };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.authLogout();
    } finally {
      setEmail(null);
      setStatus("anonymous");
      writeAuthStatusCache({ auth_required: true, gated: true });
    }
  }, []);

  const value = useMemo(
    (): AuthContextValue => ({ status, authRequired, email, passwordHint, login, logout }),
    [status, authRequired, email, passwordHint, login, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
