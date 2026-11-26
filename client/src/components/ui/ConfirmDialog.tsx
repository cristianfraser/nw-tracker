import { Modal } from "./Modal";
import styles from "./ConfirmDialog.module.css";
import { Button } from "@crfrsr/ui";

export type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  confirmDisabled?: boolean;
  /** A failed confirm's message, shown in the dialog above the buttons. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmDisabled = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} closeAriaLabel={cancelLabel}>
      <p className={styles.message}>{message}</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
      <div className={styles.actions}>
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger"
          disabled={confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
