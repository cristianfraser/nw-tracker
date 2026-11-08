import { Fragment, useEffect, useRef, useState, type HTMLAttributes } from "react";
import { Link, useLocation } from "react-router-dom";
import { Trans } from "react-i18next";
import { useTranslation } from "../i18n";
import { cn } from "../cn";
import { DashboardPage } from "./DashboardPage";
import { DashboardFoldOnlyContext } from "../dashboardFold";
import { DASHBOARD_ALIAS_PATH } from "../dashboardPath";
import { DEMO_REPO_URL } from "../components/layout/DemoTour";
import styles from "./DemoHomePage.module.css";

const CONTACT_EMAIL = "cristian.fraser@gmail.com";

/** One box of the «How it works» diagram, with where to see it in the app. */
const PIPELINE = [
  { id: "sources", to: "/panel/import-sync" },
  { id: "ingest", to: "/panel/import-sync" },
  { id: "server", to: "/panel/notifications" },
  { id: "client", to: DASHBOARD_ALIAS_PATH, here: true },
] as const;

/** Longest the move into place may take before the rest of the dashboard renders anyway. */
const MOVE_IN_FALLBACK_MS = 1200;

/** React 18 knows no `inert` prop: pass the attribute through when the side is out of view. */
function inertWhen(off: boolean): HTMLAttributes<HTMLElement> {
  return off ? ({ inert: "", "aria-hidden": true } as unknown as HTMLAttributes<HTMLElement>) : {};
}

/**
 * The hosted demo's `/` (About) and `/dashboard`, as one page: the dashboard stays mounted for
 * both, drawn small and tilted beside the About text on `/` and in place on `/dashboard`. Going
 * from one to the other is a CSS transition on the same instance, so nothing reloads.
 */
export function DemoHomePage() {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const about = pathname === "/";
  const frameRef = useRef<HTMLDivElement>(null);
  // Below-the-fold tiles render only once the dashboard has finished moving into place; a direct
  // load of /dashboard renders them at once. Coming back to About keeps them (already rendered,
  // clipped by the frame).
  const [full, setFull] = useState(!about);

  useEffect(() => {
    if (about || full) return;
    const frame = frameRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!frame || reduced) {
      setFull(true);
      return;
    }
    const done = () => setFull(true);
    const onEnd = (e: TransitionEvent) => {
      if (e.target === frame && e.propertyName === "transform") done();
    };
    frame.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(done, MOVE_IN_FALLBACK_MS);
    return () => {
      frame.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
    };
  }, [about, full]);

  return (
    <div
      className={cn(styles.host, about ? styles.modeAbout : styles.modeDashboard, !full && styles.foldOnly)}
    >
      <section className={styles.intro} aria-labelledby="demo-about-title" {...inertWhen(!about)}>
        <h1 id="demo-about-title" className={styles.title}>
          {t("demo.about.title")}
        </h1>
        <p className={styles.lead}>{t("demo.about.lead")}</p>
        <p className={styles.note}>{t("demo.about.fictional")}</p>
        <div className={styles.ctaRow}>
          <Link to={DASHBOARD_ALIAS_PATH} className={styles.cta}>
            {t("demo.about.openDashboard")}
          </Link>
        </div>

        <h2 className={styles.howTitle}>{t("demo.about.howTitle")}</h2>
        <ol className={styles.pipeline}>
          {PIPELINE.map((box, i) => (
            <Fragment key={box.id}>
              {i > 0 ? (
                <li className={styles.arrow} aria-hidden="true">
                  →
                </li>
              ) : null}
              <li className={cn(styles.box, "here" in box && styles.boxHere)}>
                <div className={styles.boxTitle}>
                  {t(`demo.about.pipeline.${box.id}.title`)}
                  {"here" in box ? <span className={styles.here}>{t("demo.about.youAreHere")}</span> : null}
                </div>
                <p className={styles.boxBody}>{t(`demo.about.pipeline.${box.id}.body`)}</p>
                <Link to={box.to} className={styles.boxLink}>
                  {t(`demo.about.pipeline.${box.id}.link`)}
                </Link>
              </li>
            </Fragment>
          ))}
        </ol>
        <p className={styles.note}>{t("demo.about.pipelineNote")}</p>

        <p className={styles.links}>
          <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer">
            {t("demo.about.source")}
          </a>
          <Link to="/privacy">{t("demo.tour.privacy")}</Link>
          <span>
            <Trans
              i18nKey="demo.about.contact"
              values={{ email: CONTACT_EMAIL }}
              components={{ mail: <a href={`mailto:${CONTACT_EMAIL}`} /> }}
            />
          </span>
        </p>
      </section>

      <div ref={frameRef} className={cn("page-grid page-root", styles.frame)} {...inertWhen(about)}>
        <DashboardFoldOnlyContext.Provider value={!full}>
          <DashboardPage />
        </DashboardFoldOnlyContext.Provider>
      </div>
    </div>
  );
}
