import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../cn";
import styles from "./Modal.module.css";

export type ModalTitleNav = {
  /** Go to the older period; null = already at oldest (button disabled). */
  onPrev: (() => void) | null;
  /** Go to the newer period; null = already at newest (button disabled). */
  onNext: (() => void) | null;
  prevAriaLabel: string;
  nextAriaLabel: string;
};

export type ModalProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  /** Pinned below the scrollable body (e.g. bulk actions). */
  footer?: ReactNode;
  className?: string;
  closeAriaLabel?: string;
  /** Prev/next period chevrons flanking the title (period-detail modals). */
  titleNav?: ModalTitleNav;
};

/** Modal dialog using the native HTML dialog element (`showModal` / `close`). */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className,
  closeAriaLabel = "Close",
  titleNav,
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const prevBtnRef = useRef<HTMLButtonElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const lastNavClick = useRef<"prev" | "next" | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onDialogClose = () => onClose();
    el.addEventListener("close", onDialogClose);
    return () => el.removeEventListener("close", onDialogClose);
  }, [onClose]);

  // A chevron that disables under focus would drop focus to <body>; hand it to the
  // opposite chevron (or close) instead so keyboard browsing keeps flowing.
  useEffect(() => {
    if (!titleNav || !lastNavClick.current) return;
    if (lastNavClick.current === "prev" && !titleNav.onPrev) {
      (titleNav.onNext ? nextBtnRef : closeBtnRef).current?.focus();
    } else if (lastNavClick.current === "next" && !titleNav.onNext) {
      (titleNav.onPrev ? prevBtnRef : closeBtnRef).current?.focus();
    }
    lastNavClick.current = null;
  }, [titleNav]);

  const heading = (
    <h2 id="modal-title" className={styles.title} aria-live={titleNav ? "polite" : undefined}>
      {title}
    </h2>
  );

  return (
    <dialog
      ref={ref}
      className={cn(styles.dialog, className)}
      onCancel={(e) => {
        e.preventDefault();
        ref.current?.close();
      }}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close();
      }}
    >
      <header className={styles.header}>
        <div>
          {titleNav ? (
            <div className={styles.titleRow}>
              <button
                ref={prevBtnRef}
                type="button"
                className={styles.navBtn}
                aria-label={titleNav.prevAriaLabel}
                disabled={!titleNav.onPrev}
                onClick={() => {
                  lastNavClick.current = "prev";
                  titleNav.onPrev?.();
                }}
              >
                ‹
              </button>
              {heading}
              <button
                ref={nextBtnRef}
                type="button"
                className={styles.navBtn}
                aria-label={titleNav.nextAriaLabel}
                disabled={!titleNav.onNext}
                onClick={() => {
                  lastNavClick.current = "next";
                  titleNav.onNext?.();
                }}
              >
                ›
              </button>
            </div>
          ) : (
            heading
          )}
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        <button
          ref={closeBtnRef}
          type="button"
          className={styles.closeBtn}
          aria-label={closeAriaLabel}
          autoFocus
          onClick={() => ref.current?.close()}
        >
          ×
        </button>
      </header>
      <div className={styles.body}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </dialog>
  );
}
