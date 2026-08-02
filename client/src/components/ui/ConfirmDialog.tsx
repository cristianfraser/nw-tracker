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
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onCancel} title={title} closeAriaLabel={cancelLabel}>
      <p className={styles.message}>{message}</p>
      <div className={styles.actions}>
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant="danger" size="sm"
          disabled={confirmDisabled}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
