import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

/** Catch-all for unknown routes (removed pages, typos): say so instead of a blank content area. */
export function NotFoundPage() {
  const { t } = useTranslation();
  const location = useLocation();
  return (
    <main>
      <h1>{t("notFound.title")}</h1>
      <p className="muted">
        {t("notFound.body", { path: location.pathname })}
      </p>
      <p>
        <Link to="/">{t("notFound.backHome")}</Link>
      </p>
    </main>
  );
}
