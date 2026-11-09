import { useCallback, useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Trans } from "react-i18next";
import { useTranslation } from "../../i18n";
import styles from "./DemoTour.module.css";
import { DASHBOARD_PATH, DEMO_BUILD } from "../../dashboardPath";

/** The hosted demo only: a first-visit welcome that can walk through the main surfaces. */
export const DEMO_TOUR_ENABLED = DEMO_BUILD;

export const DEMO_REPO_URL = "https://github.com/cristianfraser/nw-tracker";

/**
 * Per-browser convenience. The welcome opens on every load for a day from the first visit,
 * until it is closed or finished; after that day, or once closed, it stays closed.
 */
const LS_KEY = "nw-tracker.demoTour";
const LS_FIRST_SEEN_KEY = "nw-tracker.demoTour.firstSeenAt";
export const DEMO_TOUR_FIRST_VISIT_MS = 24 * 60 * 60 * 1000;
/** The sidebar footer's «Demo tour» link reopens it from the first step. */
const START_EVENT = "nw-tracker:demo-tour-start";

const TARGET_CLASS = "demo-tour-target";
const TARGET_POSITIONED_CLASS = "demo-tour-target--positioned";
const TARGET_RING_CLASS = "demo-tour-ring";
/** How long a step waits for its target to render after a navigation. */
const TARGET_WAIT_MS = 3000;

type TourStep = {
  id: "welcome" | "cards" | "chart" | "sidebar" | "flows" | "retirement" | "taxes" | "end";
  /** Route the step is about; the tour navigates there when the step opens. */
  route?: string;
  /** Elements the step points at (all outlined; the first scrolled into view), when on screen. */
  targets?: readonly TourTarget[];
};

/**
 * A selector, or a selector whose outline hugs what the element shows (`fit: "content"`):
 * a grid tile wider than its text, outlined by its own box, would frame empty space.
 */
type TourTarget = string | { selector: string; fit: "content" };

const STEPS: readonly TourStep[] = [
  { id: "welcome" },
  { id: "cards", route: DASHBOARD_PATH, targets: [".cards-strip"] },
  { id: "chart", route: DASHBOARD_PATH, targets: ['[data-tile="net-worth-chart"]'] },
  { id: "sidebar", route: DASHBOARD_PATH, targets: ['[data-tour="nav-groups"]'] },
  { id: "flows", route: DASHBOARD_PATH, targets: [{ selector: '[data-tile="flows-periods"]', fit: "content" }, '[data-tour="nav-flows"]'] },
  { id: "retirement", route: "/inversiones/retiro", targets: [".cards-strip"] },
  { id: "taxes", route: "/tax-return", targets: ['[role="tablist"]'] },
  { id: "end" },
];

/** Whether the welcome opens on this load: not closed, and within a day of the first visit. */
export function demoTourShouldOpen(closed: boolean, firstSeenAtMs: number | null, nowMs: number): boolean {
  if (closed) return false;
  if (firstSeenAtMs == null) return true;
  return nowMs - firstSeenAtMs < DEMO_TOUR_FIRST_VISIT_MS;
}

/** Reads the stored state, stamping the first visit when there is none. */
function readShouldOpen(): boolean {
  try {
    const closed = localStorage.getItem(LS_KEY) === "closed";
    const raw = localStorage.getItem(LS_FIRST_SEEN_KEY);
    const parsed = raw == null ? NaN : Date.parse(raw);
    const firstSeen = Number.isFinite(parsed) ? parsed : null;
    const now = Date.now();
    if (firstSeen == null) localStorage.setItem(LS_FIRST_SEEN_KEY, new Date(now).toISOString());
    return demoTourShouldOpen(closed, firstSeen, now);
  } catch {
    // Storage blocked: the welcome shows on each load, and Dismiss hides it for the page's life.
    return true;
  }
}

function writeClosed(): void {
  try {
    localStorage.setItem(LS_KEY, "closed");
  } catch {
    // Storage blocked: nothing to remember.
  }
}

export function startDemoTour(): void {
  window.dispatchEvent(new Event(START_EVENT));
}

/** Smallest box around everything the element draws: its text and its icons. */
function contentRect(el: Element): DOMRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  const add = (r: DOMRect) => {
    if (r.width === 0 && r.height === 0) return;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  };
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.textContent?.trim()) continue;
    range.selectNodeContents(node);
    for (const r of range.getClientRects()) add(r);
  }
  for (const svg of el.querySelectorAll("svg")) add(svg.getBoundingClientRect());
  return Number.isFinite(left) ? new DOMRect(left, top, right - left, bottom - top) : null;
}

const RING_PAD_PX = 8;

/** Outline the step's targets once they render, and drop the outlines when the step changes. */
function useStepTargets(targets: readonly TourTarget[] | undefined, pathname: string): void {
  const key = targets ? JSON.stringify(targets) : "";
  useEffect(() => {
    if (!key) return;
    const wanted = (JSON.parse(key) as TourTarget[]).map((t) =>
      typeof t === "string" ? { selector: t, fit: undefined } : t
    );
    const found = new Map<string, Element>();
    const rings: { el: Element; ring: HTMLDivElement }[] = [];
    let frame = 0;
    let ringFrame = 0;
    const started = performance.now();
    const visible = (el: Element | null): el is Element => !!el && (el as HTMLElement).offsetParent !== null;
    // Content-fitted outlines are drawn as fixed rings that follow the element every frame.
    const placeRings = () => {
      for (const { el, ring } of rings) {
        const r = contentRect(el);
        ring.style.display = r ? "" : "none";
        if (!r) continue;
        ring.style.left = `${r.left - RING_PAD_PX}px`;
        ring.style.top = `${r.top - RING_PAD_PX}px`;
        ring.style.width = `${r.width + 2 * RING_PAD_PX}px`;
        ring.style.height = `${r.height + 2 * RING_PAD_PX}px`;
      }
      ringFrame = requestAnimationFrame(placeRings);
    };
    const find = () => {
      for (const { selector, fit } of wanted) {
        if (found.has(selector)) continue;
        const el = document.querySelector(selector);
        if (!visible(el)) continue;
        if (fit === "content") {
          const ring = document.createElement("div");
          ring.className = TARGET_RING_CLASS;
          document.body.appendChild(ring);
          rings.push({ el, ring });
          if (rings.length === 1) ringFrame = requestAnimationFrame(placeRings);
        } else {
          el.classList.add(TARGET_CLASS);
          // Above the fixed ticker: a static element needs a position for its z-index to apply,
          // a sticky or positioned one keeps its own.
          if (getComputedStyle(el).position === "static") el.classList.add(TARGET_POSITIONED_CLASS);
        }
        // The first target is what the step is about; the page scrolls to it.
        if (selector === wanted[0].selector) el.scrollIntoView({ block: "center", behavior: "smooth" });
        found.set(selector, el);
      }
      if (found.size < wanted.length && performance.now() - started < TARGET_WAIT_MS) {
        frame = requestAnimationFrame(find);
      }
    };
    find();
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(ringFrame);
      for (const el of found.values()) el.classList.remove(TARGET_CLASS, TARGET_POSITIONED_CLASS);
      for (const { ring } of rings) ring.remove();
    };
  }, [key, pathname]);
}

export function DemoTour() {
  if (!DEMO_TOUR_ENABLED) return null;
  return <DemoTourPopover />;
}

function DemoTourPopover() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [open, setOpen] = useState(readShouldOpen);
  const [index, setIndex] = useState(0);
  const step = STEPS[index];

  useEffect(() => {
    const onStart = () => {
      setIndex(0);
      setOpen(true);
    };
    window.addEventListener(START_EVENT, onStart);
    return () => window.removeEventListener(START_EVENT, onStart);
  }, []);

  useStepTargets(open && pathname !== "/" ? step.targets : undefined, pathname);

  const goTo = useCallback(
    (next: number) => {
      const s = STEPS[next];
      setIndex(next);
      // Seeing the end is the same as dismissing: the welcome does not open again on reload.
      if (next === STEPS.length - 1) writeClosed();
      if (s.route && s.route !== pathname) navigate(s.route);
    },
    [navigate, pathname]
  );

  const close = useCallback(() => {
    writeClosed();
    setOpen(false);
  }, []);

  // The tour is about the dashboard: it waits on the About page (the demo's `/`).
  if (!open || pathname === "/") return null;

  const first = index === 0;
  const last = index === STEPS.length - 1;
  const titleId = "demo-tour-title";

  return (
    <div className={styles.dock}>
      <section className={styles.popover} role="dialog" aria-modal="false" aria-labelledby={titleId}>
        <div className={styles.header}>
          <strong id={titleId} className={styles.title}>
            {t(`demo.tour.steps.${step.id}.title`)}
          </strong>
          <button type="button" className={styles.close} onClick={close} aria-label={t("demo.tour.dismiss")}>
            ×
          </button>
        </div>
        {last ? (
          <>
            <p className={styles.body}>
              <Trans
                i18nKey="demo.tour.steps.end.body"
                components={{ repo: <a href={DEMO_REPO_URL} target="_blank" rel="noreferrer" /> }}
              />
            </p>
            <p className={styles.body}>
              <Trans
                i18nKey="demo.tour.contact"
                components={{ mail: <a href="mailto:cristian.fraser@gmail.com" /> }}
              />
            </p>
            <p className={styles.body}>
              <Link to="/privacy">{t("demo.tour.privacy")}</Link>
            </p>
          </>
        ) : (
          <p className={styles.body}>{t(`demo.tour.steps.${step.id}.body`)}</p>
        )}
        <div className={styles.actions}>
          {first ? (
            <>
              <button type="button" className={styles.buttonOutline} onClick={close}>
                {t("demo.tour.dismiss")}
              </button>
              <button type="button" className={styles.button} onClick={() => goTo(1)}>
                {t("demo.tour.start")}
              </button>
            </>
          ) : (
            <>
              <span className={styles.count}>
                {t("demo.tour.stepCount", { n: index, total: STEPS.length - 1 })}
              </span>
              <button type="button" className={styles.button} onClick={() => goTo(index - 1)}>
                {t("demo.tour.back")}
              </button>
              {last ? (
                <button type="button" className={styles.button} onClick={close}>
                  {t("demo.tour.finish")}
                </button>
              ) : (
                <button type="button" className={styles.button} onClick={() => goTo(index + 1)}>
                  {t("demo.tour.next")}
                </button>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
