import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { useAuth, type AuthLoginErrorCode } from "../context/AuthContext";
import { useTranslation } from "../i18n";
import styles from "./LoginPage.module.css";

/** Only allow same-origin, absolute in-app paths as the post-login destination (no open redirect). */
export function safeNextPath(raw: string | null): string {
  if (!raw) return "/";
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  if (!decoded.startsWith("/") || decoded.startsWith("//")) return "/";
  return decoded;
}

function loginErrorKey(code: AuthLoginErrorCode): string {
  return code === "invalid_email"
    ? "auth.errors.invalidEmail"
    : code === "invalid_credentials"
      ? "auth.errors.invalidCredentials"
      : "auth.errors.unknown";
}

export function LoginPage() {
  const { t } = useTranslation();
  const { login, passwordHint } = useAuth();
  const [searchParams] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState(passwordHint ?? "");
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // The page can mount before /api/auth/status resolves (optimistic auth seed); adopt the
  // demo hint as the prefill once it arrives, unless the user already typed a password.
  useEffect(() => {
    if (passwordHint) setPassword((prev) => (prev === "" ? passwordHint : prev));
  }, [passwordHint]);

  // Destination is applied by the /login route once auth flips (see App.tsx LoginRedirect),
  // so a successful submit just needs to leave this component mounted while status updates.
  const nextPath = safeNextPath(searchParams.get("next"));

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setErrorKey(null);
    setSubmitting(true);
    const result = await login(email, password);
    if (!result.ok) {
      setErrorKey(loginErrorKey(result.code));
      setSubmitting(false);
    }
    // On success we keep `submitting` true: the app re-renders past the gate and unmounts us.
  }

  return (
    <div className={styles.host}>
      <form className={styles.card} onSubmit={onSubmit}>
        <div className={styles.brand}>nw-tracker</div>
        <h1 className={styles.title}>{t("auth.title")}</h1>
        <p className={styles.subtitle}>{t("auth.subtitle")}</p>

        <label className={styles.field}>
          <span className={styles.label}>{t("auth.emailLabel")}</span>
          <input
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={t("auth.emailPlaceholder")}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>{t("auth.passwordLabel")}</span>
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>

        {passwordHint ? (
          <p className={styles.hint}>{t("auth.passwordHint", { hint: passwordHint })}</p>
        ) : null}

        {errorKey ? <p className={styles.error}>{t(errorKey)}</p> : null}

        <button className={styles.submit} type="submit" disabled={submitting}>
          {submitting ? t("auth.submitting") : t("auth.submit")}
        </button>

        {/* Hidden metadata: which route the user was heading to before the gate. */}
        <input type="hidden" name="next" value={nextPath} readOnly />
      </form>
    </div>
  );
}
