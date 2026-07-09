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

/**
 * Demo login state. `authRequired` mirrors the server's `AUTH_PASSWORD` env: in local personal
 * mode it is false and the app is never gated (status is forced to `authenticated`). In hosted
 * demo mode the app routes only render once a valid session cookie exists; otherwise the route
 * guard sends the user to the in-app `/login` page.
 */
export type AuthStatus = "loading" | "anonymous" | "authenticated";
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [authRequired, setAuthRequired] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [passwordHint, setPasswordHint] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .authStatus()
      .then((s) => {
        if (cancelled) return;
        setAuthRequired(s.auth_required);
        setPasswordHint(s.password_hint);
        setEmail(s.email);
        // Local mode (no auth) is never gated; otherwise gate until a valid session exists.
        setStatus(!s.auth_required || s.authenticated ? "authenticated" : "anonymous");
      })
      .catch(() => {
        // /api/auth/status is exempt from auth, so a failure here means the API is unreachable.
        // Fall back to the gated state so the login page (rather than a broken app) is shown.
        if (!cancelled) {
          setAuthRequired(true);
          setStatus("anonymous");
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    // A gated /api request returning 401 (session expired mid-session) → back to the login gate.
    const onExpired = () => {
      setEmail(null);
      setStatus((prev) => (prev === "authenticated" ? "anonymous" : prev));
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
