import styles from "./PageTitleRow.module.css";

export function PageTitleRow({ title }: { title: string }) {
  return (
    <div className={styles.row}>
      <h1 className={styles.title}>{title}</h1>
    </div>
  );
}
