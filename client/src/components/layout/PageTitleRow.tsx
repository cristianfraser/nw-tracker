import type { EntityColorTarget } from "../../entityColor";
import { EntityColorPicker } from "../dashboard/EntityColorPicker";
import styles from "./PageTitleRow.module.css";

export function PageTitleRow({
  title,
  colorRgb,
  colorTarget,
}: {
  title: string;
  colorRgb?: string | null;
  colorTarget?: EntityColorTarget;
}) {
  return (
    <div className={styles.row}>
      <h1 className={styles.title}>{title}</h1>
      {colorTarget ? (
        <EntityColorPicker colorRgb={colorRgb} colorTarget={colorTarget} size="page" />
      ) : null}
    </div>
  );
}
