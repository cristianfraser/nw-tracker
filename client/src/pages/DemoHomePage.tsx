import { Fragment, startTransition, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type RefObject } from "react";
import { Link, useLocation } from "react-router-dom";
import { Trans } from "react-i18next";
import { useTranslation } from "../i18n";
import { cn } from "../cn";
import { DashboardPage } from "./DashboardPage";
import { DashboardAboutPreviewContext, DashboardFoldContext, type DashboardFold } from "../dashboardFold";
import { DASHBOARD_ALIAS_PATH } from "../dashboardPath";
import { skipNextScrollRestore } from "../useScrollMemory";
import { DEMO_REPO_URL } from "../components/layout/DemoTour";
import { setDemoDashboardMovingIn } from "../demoTickerGate";
import { useDisplayPreferences } from "../context/DisplayPreferencesContext";
import { useMarketTicker } from "../queries/hooks";
import styles from "./DemoHomePage.module.css";

const CONTACT_EMAIL = "cristian.fraser@gmail.com";

/** One box of the «How it works» diagram, with where to see it in the app. */
const PIPELINE = [
  { id: "sources", to: "/panel/import-sync" },
  { id: "ingest", to: "/panel/import-sync" },
  { id: "server", to: "/panel/notifications" },
  { id: "client", to: DASHBOARD_ALIAS_PATH, here: true },
] as const;

/** The About text's fade-out at the start of the move in (`.modeDashboard.foldOnly .intro`); the
 * page returns to the top once it is invisible. */
const INTRO_FADE_OUT_MS = 200;

/**
 * True once the browser has been idle after mount (`requestIdleCallback`, else a short timeout),
 * for low-priority work after the first paint. Stays true; `wanted` false skips the wait.
 */
function useIdleAfterMount(wanted: boolean): boolean {
  const [idle, setIdle] = useState(!wanted);
  useEffect(() => {
    if (idle) return;
    const done = () => startTransition(() => setIdle(true));
    if (typeof window.requestIdleCallback === "function") {
      const id = window.requestIdleCallback(done, { timeout: 2000 });
      return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(done, 300);
    return () => window.clearTimeout(id);
  }, [idle]);
  return idle;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Longest the move into place may take before the rest of the dashboard renders anyway. */
const MOVE_IN_FALLBACK_MS = 1200;

/** Space kept below the net-worth chart's legend when the About preview is cut there (px). */
const PREVIEW_BOTTOM_GAP_PX = 16;

/** An element's offset from the document top in layout pixels (transforms do not count). */
function layoutTop(el: HTMLElement): number {
  let top = 0;
  for (let e: HTMLElement | null = el; e; e = e.offsetParent as HTMLElement | null) top += e.offsetTop;
  return top;
}

/**
 * The About preview's height: the dashboard down to the end of its net-worth chart (legend
 * included), measured in the untransformed layout and kept current as the chart loads or resizes.
 */
function usePreviewHeight(frameRef: RefObject<HTMLDivElement>): number | null {
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let observed: HTMLElement | null = null;
    const measure = () => {
      const tile = frame.querySelector<HTMLElement>('[data-tile="net-worth-chart"]');
      if (!tile) return;
      if (tile !== observed) {
        if (observed) ro.unobserve(observed);
        ro.observe(tile);
        observed = tile;
      }
      setHeight(layoutTop(tile) + tile.offsetHeight - layoutTop(frame) + PREVIEW_BOTTOM_GAP_PX);
    };
    const ro = new ResizeObserver(measure);
    ro.observe(frame);
    // The tile mounts with the dashboard's first render; watch for it until then.
    const mo = new MutationObserver(measure);
    mo.observe(frame, { childList: true, subtree: true });
    measure();
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
  }, [frameRef]);
  return height;
}

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
  // load of /dashboard renders them at once. Coming back to About drops them again, so every move
  // in animates the first screen alone.
  const [full, setFull] = useState(!about);
  const previewHeight = usePreviewHeight(frameRef);
  // Leaving a scrolled About: the page stays in its About state (pinned preview, text fading out)
  // until it is back at the top, and only then is the preview released and moved in. Decided while
  // rendering the route change, so the dashboard state never reaches the screen first.
  const [leaving, setLeaving] = useState(false);
  const [lastAbout, setLastAbout] = useState(about);
  if (lastAbout !== about) {
    setLastAbout(about);
    setLeaving(!about && window.scrollY > 0 && !prefersReducedMotion());
  }
  const shownAbout = about || leaving;
  if (shownAbout && full) setFull(false);
  // The tiles below the fold are rendered hidden once the browser is idle on About (their own
  // queries stay off), so the move ends with nothing to render and no layout change.
  const belowFoldRendered = useIdleAfterMount(!full);
  const fold: DashboardFold = full ? "full" : belowFoldRendered ? "hidden" : "cut";
  // The ticker is held back on About; keep its prices loaded meanwhile so it is ready the
  // moment it mounts.
  const { displayUnit } = useDisplayPreferences();
  useMarketTicker(displayUnit);

  // While the dashboard moves in from About the app shell keeps the ticker unmounted. A layout
  // effect, so the ticker never paints for a frame on the way in.
  // One element for the page's life: the route change re-renders this host, never the dashboard
  // (which reads no route) — it only re-renders for its own data and the two contexts below.
  const dashboard = useMemo(() => <DashboardPage />, []);
  const movingIn = !about && !full;
  useLayoutEffect(() => {
    setDemoDashboardMovingIn(movingIn);
  }, [movingIn]);
  useLayoutEffect(() => () => setDemoDashboardMovingIn(false), []);

  // The preview is pinned while About scrolls (sticky at its own resting offset, `--about-frame-top`),
  // so the page can return to the top behind it without the dashboard moving.
  const introRef = useRef<HTMLElement>(null);
  const [frameTop, setFrameTop] = useState<number | null>(null);
  useLayoutEffect(() => {
    const intro = introRef.current;
    if (!about || !intro) return;
    // The text column is never transformed: its on-screen top plus the scroll is its document offset.
    const measure = () => setFrameTop(Math.round(intro.getBoundingClientRect().top + window.scrollY));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(document.documentElement);
    return () => ro.disconnect();
  }, [about]);

  // Into the dashboard: it opens at the top. The scroll memory leaves this arrival alone (it would
  // restore an earlier /dashboard position mid-move). From a scrolled About the text fades out,
  // the page returns to the top behind it (the pinned preview stays where it is), and only then
  // does the preview leave its pin and move in.
  const wasAbout = useRef(about);
  useLayoutEffect(() => {
    const leftAbout = wasAbout.current && !about;
    wasAbout.current = about;
    if (!leftAbout) return;
    skipNextScrollRestore(pathname);
    if (window.scrollY === 0) return;
    if (!leaving) {
      // Reduced motion: no fade, straight to the top.
      window.scrollTo({ top: 0 });
      return;
    }
    const toTop = window.setTimeout(() => {
      window.scrollTo({ top: 0 });
      setLeaving(false);
    }, INTRO_FADE_OUT_MS);
    return () => window.clearTimeout(toTop);
    // `leaving` is read once, on the commit that left About.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [about, pathname]);

  useEffect(() => {
    if (shownAbout || full) return;
    const frame = frameRef.current;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!frame || reduced) {
      setFull(true);
      return;
    }
    // The rest of the dashboard is low-priority work: the ticker's slide-in and input go first.
    const done = () => startTransition(() => setFull(true));
    const onEnd = (e: TransitionEvent) => {
      if (e.target === frame && e.propertyName === "transform") done();
    };
    frame.addEventListener("transitionend", onEnd);
    const fallback = window.setTimeout(done, MOVE_IN_FALLBACK_MS);
    return () => {
      frame.removeEventListener("transitionend", onEnd);
      window.clearTimeout(fallback);
    };
  }, [shownAbout, full]);

  return (
    <div
      className={cn(
        styles.host,
        shownAbout ? styles.modeAbout : styles.modeDashboard,
        !full && styles.foldOnly,
        leaving && styles.leaving
      )}
      style={
        {
          ...(previewHeight == null ? {} : { "--about-preview-height": `${previewHeight}px` }),
          ...(frameTop == null ? {} : { "--about-frame-top": `${frameTop}px` }),
        } as CSSProperties
      }
    >
      <section ref={introRef} className={styles.intro} aria-labelledby="demo-about-title" {...inertWhen(!about)}>
        <h1 id="demo-about-title" className={styles.title}>
          {t("demo.about.title")}
        </h1>
        <p className={styles.lead}>{t("demo.about.lead")}</p>
        <p className={styles.note}>{t("demo.about.fictional")}</p>
        <p className={styles.note}>{t("demo.about.story")}</p>
        <p className={styles.note}>{t("demo.about.storyTax")}</p>
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

      {/* The pin holds the preview in place while About scrolls (sticky, zero height). */}
      <div className={cn("page-grid", styles.pin)}>
        <div ref={frameRef} className={cn("page-grid page-root", styles.frame)} {...inertWhen(about)}>
          <DashboardFoldContext.Provider value={fold}>
            {/* Still a preview while it moves in: the flag only matters on the first draw, and
                flipping it at the click would re-render the dashboard while the move starts. */}
            <DashboardAboutPreviewContext.Provider value={about || !full}>{dashboard}</DashboardAboutPreviewContext.Provider>
          </DashboardFoldContext.Provider>
        </div>
      </div>
    </div>
  );
}
