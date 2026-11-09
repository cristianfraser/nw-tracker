import { PageGridTile } from "../components/layout/PageGridTile";
import { useTranslation } from "../i18n";

const SECTIONS = ["visits", "pages", "cloudflare", "browser", "hosting"] as const;

/** Demo only (routed when VITE_DEMO_MODE): what the public demo records about visits. */
export function PrivacyPage() {
  const { t } = useTranslation();
  return (
    <main className="privacy-page">
      <h1>{t("demo.privacy.title")}</h1>
      <p>{t("demo.privacy.intro")}</p>
      {SECTIONS.map((s) => (
        <PageGridTile key={s} id={`privacy-${s}`}>
          <h2>{t(`demo.privacy.${s}Title`)}</h2>
          <p>{t(`demo.privacy.${s}Body`)}</p>
        </PageGridTile>
      ))}
      <p className="muted">{t("demo.privacy.contact")}</p>
    </main>
  );
}
