import { ColorThumb as AriaColorThumb, type ColorThumbProps } from "react-aria-components";
import styles from "./ColorPickerThumb.module.css";

/** Draggable thumb for React Aria `ColorArea` / `ColorSlider` tracks. */
export function ColorPickerThumb(props: ColorThumbProps) {
  return (
    <AriaColorThumb
      {...props}
      className={styles.thumb}
      style={({ defaultStyle, isDisabled }) => ({
        ...defaultStyle,
        backgroundColor: isDisabled ? undefined : defaultStyle.backgroundColor,
      })}
    />
  );
}
