import styles from "./PageTitleRow.module.css";

/**
 * An empty title (the name is not known yet — first-ever visit, no nav tree) still takes the
 * height of a real one, so the layout does not jump when the name lands.
 */
export function PageTitleRow({ title }: { title: string }) {
  return (
    <div className={styles.row}>
      <h1 className={styles.title} aria-hidden={title ? undefined : true}>
        {title || "\u00A0"}
      </h1>
    </div>
  );
}
