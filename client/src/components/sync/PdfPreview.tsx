import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask, TextLayer } from "pdfjs-dist/legacy/build/pdf.mjs";
import { useTranslation } from "../../i18n";
import { Loadable } from "../ui/Loadable";
import { loadPdfjs, pdfjsAssetUrl, type PdfjsModule } from "./pdfjsLoader";
import { PDF_ERROR_MESSAGE_KEYS, pdfErrorKind, type PdfErrorKind } from "./pdfViewerErrors";
import { canStepPdfScale, canvasPixelCap, canvasPixelRatio, fitWidthScale, stepPdfScale } from "./pdfZoom";
import styles from "./PdfPreview.module.css";

/** A page's size at scale 1 (PDF points), known before it renders so its box holds its place. */
type PageSize = { width: number; height: number };

type LoadState =
  | { status: "loading" }
  | { status: "error"; kind: PdfErrorKind }
  | { status: "password" }
  | { status: "ready"; pdfjs: PdfjsModule; doc: PDFDocumentProxy; pages: PageSize[] };

type Zoom = { kind: "fit" } | { kind: "manual"; scale: number };

/** Resizes settle this long before the fit-width scale follows them. */
const RESIZE_DEBOUNCE_MS = 150;

/** A touch device (coarse pointer, or touch points as an iPad reports them) gets the lower canvas cap. */
function isTouchDevice(): boolean {
  return window.matchMedia("(pointer: coarse)").matches || navigator.maxTouchPoints > 1;
}

/** Frees a canvas's bitmap at once (browsers, Safari above all, keep it until collection). */
function releaseCanvas(canvas: HTMLCanvasElement | null | undefined): void {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}

/** The view's centre as a fraction of the content (null before there is any content). */
function viewCentre(el: HTMLElement): { x: number; y: number } | null {
  if (el.scrollWidth === 0 || el.scrollHeight === 0) return null;
  return {
    x: (el.scrollLeft + el.clientWidth / 2) / el.scrollWidth,
    y: (el.scrollTop + el.clientHeight / 2) / el.scrollHeight,
  };
}

/**
 * A page box: its place at the current scale, always; a canvas and text layer only while it is
 * within a screen of the view. Leaving that margin frees them; the box keeps its size.
 */
function PdfPage({
  pdfjs,
  doc,
  pageNumber,
  size,
  scale,
  scroller,
  onError,
}: {
  pdfjs: PdfjsModule;
  doc: PDFDocumentProxy;
  pageNumber: number;
  size: PageSize;
  scale: number;
  scroller: HTMLElement;
  onError: (e: unknown) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const textHostRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  // Near = within a screen of the view, above or below; it turns off again past that margin.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setNear(entry.isIntersecting);
    }, { root: scroller, rootMargin: "100% 0px" });
    io.observe(box);
    return () => io.disconnect();
  }, [scroller]);

  // Out of the margin: drop the drawn page and its text.
  useEffect(() => {
    if (near) return;
    const host = canvasHostRef.current;
    releaseCanvas(host?.querySelector("canvas"));
    host?.replaceChildren();
    textHostRef.current?.replaceChildren();
  }, [near]);

  // While near, at every scale: a canvas at the device's pixel ratio, then the selectable text
  // over it. The previous canvas stays (stretched) until the new one is drawn, then is freed.
  useEffect(() => {
    if (!near) return;
    let cancelled = false;
    let renderTask: RenderTask | null = null;
    let textLayer: TextLayer | null = null;
    /** The canvas being drawn, until it is shown; freed if the render is cancelled. */
    let pending: HTMLCanvasElement | null = null;
    void (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const ratio = canvasPixelRatio(viewport.width, viewport.height, window.devicePixelRatio, canvasPixelCap(isTouchDevice()));
      const canvas = document.createElement("canvas");
      pending = canvas;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      renderTask = page.render({
        canvas,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      });
      await renderTask.promise;
      if (cancelled) return;
      const host = canvasHostRef.current;
      releaseCanvas(host?.querySelector("canvas"));
      host?.replaceChildren(canvas);
      pending = null;
      const textDiv = document.createElement("div");
      textDiv.className = "textLayer";
      textLayer = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: textDiv,
        viewport,
      });
      await textLayer.render();
      if (cancelled) return;
      textHostRef.current?.replaceChildren(textDiv);
    })().catch((e: unknown) => {
      if (cancelled || e instanceof pdfjs.RenderingCancelledException || e instanceof pdfjs.AbortException) return;
      onError(e);
    });
    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      releaseCanvas(pending);
    };
  }, [near, scale, doc, pageNumber, pdfjs, onError]);

  const style = {
    width: `${size.width * scale}px`,
    height: `${size.height * scale}px`,
    // The text layer sizes itself from these (pdf.js `setLayerDimensions`).
    "--total-scale-factor": String(scale),
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as CSSProperties;
  return (
    <div ref={boxRef} className={styles.page} style={style}>
      <div ref={canvasHostRef} className={styles.canvasHost} />
      <div ref={textHostRef} className={styles.textHost} />
    </div>
  );
}

/**
 * A PDF drawn by pdf.js inside the dialog (no iframe: Esc reaches the dialog, and phones show it
 * too). Pages are stacked in a focusable scroll box, fitted to its width by default, with zoom
 * out / in / fit; each page draws when it nears the view. The file is read with range requests.
 * A password-protected file gets a note pointing to the browser's own viewer. Keyed by its URL
 * by the caller, so another document starts from a fresh state.
 */
export function PdfPreview({ url }: { url: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [zoom, setZoom] = useState<Zoom>({ kind: "fit" });
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [availableWidth, setAvailableWidth] = useState<number | null>(null);
  /** The view's centre before a scale change, put back after it. */
  const anchor = useRef<{ x: number; y: number } | null>(null);
  const [renderError, setRenderError] = useState<PdfErrorKind | null>(null);
  const onPageError = useCallback((e: unknown) => {
    console.error("pdf viewer: could not draw a page", e);
    setRenderError(pdfErrorKind(e));
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: PDFDocumentLoadingTask | null = null;
    void (async () => {
      const pdfjs = await loadPdfjs();
      if (cancelled) return;
      task = pdfjs.getDocument({
        url,
        // The standard fonts are served (pdfjsAssetUrl), so a missing font is drawn from them,
        // the same on every system, not from whatever the machine has installed.
        useSystemFonts: false,
        standardFontDataUrl: pdfjsAssetUrl("standard_fonts"),
        wasmUrl: pdfjsAssetUrl("wasm"),
        iccUrl: pdfjsAssetUrl("iccs"),
      });
      try {
        const doc = await task.promise;
        const pages = await Promise.all(
          Array.from({ length: doc.numPages }, async (_, i) => {
            const v = (await doc.getPage(i + 1)).getViewport({ scale: 1 });
            return { width: v.width, height: v.height };
          })
        );
        if (!cancelled) setState({ status: "ready", pdfjs, doc, pages });
      } catch (e) {
        if (cancelled) return;
        if (e instanceof pdfjs.PasswordException) setState({ status: "password" });
        else throw e;
      }
    })().catch((e: unknown) => {
      if (cancelled) return;
      console.error("pdf viewer: could not open", url, e);
      setState({ status: "error", kind: pdfErrorKind(e) });
    });
    return () => {
      cancelled = true;
      // Destroys the document too, and aborts its pending range requests.
      void task?.destroy();
    };
  }, [url]);

  // The width the pages may fill: the box's, less the pages' own padding. The first reading is
  // taken at once, later ones once a resize settles.
  useEffect(() => {
    if (!scroller) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const pads = pagesRef.current ? getComputedStyle(pagesRef.current) : null;
      const padding = pads ? parseFloat(pads.paddingLeft) + parseFloat(pads.paddingRight) : 0;
      return scroller.clientWidth - padding;
    };
    let width = measure();
    setAvailableWidth(width);
    // The observer also reports once on observe(): an unchanged width is no resize.
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const next = measure();
        if (next === width) return;
        width = next;
        anchor.current = viewCentre(scroller);
        setAvailableWidth(next);
      }, RESIZE_DEBOUNCE_MS);
    });
    ro.observe(scroller);
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, [scroller]);

  const ready = state.status === "ready" ? state : null;
  const widest = ready ? ready.pages.reduce((w, p) => Math.max(w, p.width), 0) : 0;
  const fitScale = ready && availableWidth != null && widest > 0 ? fitWidthScale(availableWidth, widest) : null;
  const scale = zoom.kind === "manual" ? zoom.scale : fitScale;

  // After a scale change, put the same point of the document back at the view's centre. The first
  // scale (the pages appearing) keeps the top: an anchor taken before there were pages is dropped.
  const previousScale = useRef<number | null>(null);
  useLayoutEffect(() => {
    const a = anchor.current;
    const hadPages = previousScale.current != null;
    previousScale.current = scale;
    anchor.current = null;
    if (!a || !scroller || !hadPages || scale == null) return;
    scroller.scrollTo({
      left: a.x * scroller.scrollWidth - scroller.clientWidth / 2,
      top: a.y * scroller.scrollHeight - scroller.clientHeight / 2,
    });
  }, [scale, scroller]);

  // Once the pages are in, arrow, space and page keys scroll them without a click first — when
  // focus is still where the dialog put it (its close button, the header's own button, or the
  // dialog itself), never taken from Download or a zoom button.
  const readyNow = ready != null;
  useEffect(() => {
    if (!readyNow || !scroller) return;
    const dialog = scroller.closest("dialog");
    const active = document.activeElement;
    if (dialog && (active === dialog || active === dialog.querySelector(":scope > header > button"))) {
      scroller.focus({ preventScroll: true });
    }
  }, [readyNow, scroller]);

  const errorKind = state.status === "error" ? state.kind : renderError;
  if (errorKind != null) {
    return (
      <p className={`error ${styles.note}`} role="alert">
        {t(PDF_ERROR_MESSAGE_KEYS[errorKind])}
      </p>
    );
  }
  if (state.status === "password") {
    return (
      <p className={`muted ${styles.note}`} role="status">
        {t("importSync.viewer.pdfPasswordProtected", { action: t("importSync.viewer.openInTab") })}
      </p>
    );
  }

  const setScale = (next: Zoom) => {
    if (scroller) anchor.current = viewCentre(scroller);
    setZoom(next);
  };
  const pageCount = ready?.pages.length ?? null;
  return (
    <Loadable loading={state.status === "loading"} className={styles.frame}>
      <div className={`surface-controls ${styles.bar}`}>
        <span className="surface-controls__set" role="group" aria-label={t("importSync.viewer.zoomLabel")}>
          <button
            type="button"
            disabled={scale == null || !canStepPdfScale(scale, -1)}
            aria-label={t("importSync.viewer.zoomOut")}
            title={t("importSync.viewer.zoomOut")}
            onClick={() => scale != null && setScale({ kind: "manual", scale: stepPdfScale(scale, -1) })}
          >
            −
          </button>
          <button
            type="button"
            disabled={scale == null || !canStepPdfScale(scale, 1)}
            aria-label={t("importSync.viewer.zoomIn")}
            title={t("importSync.viewer.zoomIn")}
            onClick={() => scale != null && setScale({ kind: "manual", scale: stepPdfScale(scale, 1) })}
          >
            +
          </button>
          <button
            type="button"
            className={zoom.kind === "fit" ? "is-on" : undefined}
            aria-pressed={zoom.kind === "fit"}
            title={t("importSync.viewer.fitWidthName")}
            onClick={() => setScale({ kind: "fit" })}
          >
            {t("importSync.viewer.fitWidth")}
          </button>
        </span>
        {pageCount != null ? (
          <span className={`muted ${styles.count}`}>
            {pageCount === 1 ? t("importSync.viewer.pageCountOne") : t("importSync.viewer.pageCount", { n: pageCount })}
          </span>
        ) : null}
      </div>
      <div ref={setScroller} className={styles.scroller} tabIndex={0} aria-label={t("importSync.viewer.pagesLabel")}>
        <div ref={pagesRef} className={styles.pages}>
          {ready && scroller && scale != null
            ? ready.pages.map((size, i) => (
                <PdfPage
                  key={i}
                  pdfjs={ready.pdfjs}
                  doc={ready.doc}
                  pageNumber={i + 1}
                  size={size}
                  scale={scale}
                  scroller={scroller}
                  onError={onPageError}
                />
              ))
            : null}
        </div>
      </div>
    </Loadable>
  );
}
