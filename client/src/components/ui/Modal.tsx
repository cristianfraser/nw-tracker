import { useEffect, useRef, type ReactNode } from "react";
import { cn } from "../../cn";
import styles from "./Modal.module.css";

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
}: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

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
          <h2 id="modal-title" className={styles.title}>
            {title}
          </h2>
          {subtitle ? <p className={styles.subtitle}>{subtitle}</p> : null}
        </div>
        <button
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
