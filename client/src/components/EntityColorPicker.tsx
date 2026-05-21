import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Button,
  ColorArea,
  ColorField,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  Dialog,
  DialogTrigger,
  Popover,
  SliderTrack,
  parseColor,
  type Color,
} from "react-aria-components";
import { ColorPickerThumb } from "./ColorPickerThumb";
import {
  clearEntityColor,
  colorToRgbTriplet,
  parseEntityColorRgb,
  persistEntityColor,
  type EntityColorTarget,
} from "../entityColor";
import { queryKeys } from "../queries/keys";
import styles from "./EntityColorPicker.module.css";

const DEBOUNCE_MS = 400;

function invalidateColorQueries(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarNav() });
  void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
  void queryClient.invalidateQueries({ queryKey: ["valuationTimeseries"] });
  void queryClient.invalidateQueries({ queryKey: ["portfolioGroup"] });
  void queryClient.invalidateQueries({ queryKey: ["accountDetail"] });
  void queryClient.invalidateQueries({ queryKey: ["groupMonthlyPerformance"] });
  void queryClient.invalidateQueries({ queryKey: ["accountMonthlyPerformance"] });
}

export function EntityColorPicker({
  colorRgb,
  colorTarget,
  size = "page",
}: {
  colorRgb: string | null | undefined;
  colorTarget: EntityColorTarget;
  size?: "page" | "compact";
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [value, setValue] = useState(() => parseEntityColorRgb(colorRgb));
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<string | null>(null);

  useEffect(() => {
    setValue(parseEntityColorRgb(colorRgb));
  }, [colorRgb]);

  const mutation = useMutation({
    mutationFn: ({ target, triplet }: { target: EntityColorTarget; triplet: string }) =>
      persistEntityColor(target, triplet),
    onSuccess: () => invalidateColorQueries(queryClient),
  });

  const clearMutation = useMutation({
    mutationFn: (target: EntityColorTarget) => clearEntityColor(target),
    onSuccess: (result) => {
      try {
        setValue(parseColor(result.color));
      } catch {
        setValue(parseEntityColorRgb(colorRgb));
      }
      invalidateColorQueries(queryClient);
    },
  });

  const flushPending = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    const triplet = pendingRef.current;
    pendingRef.current = null;
    if (!triplet) return;
    mutation.mutate({ target: colorTarget, triplet });
  }, [colorTarget, mutation]);

  const schedulePersist = useCallback(
    (color: Color) => {
      const triplet = colorToRgbTriplet(color);
      pendingRef.current = triplet;
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next) mutation.mutate({ target: colorTarget, triplet: next });
      }, DEBOUNCE_MS);
    },
    [colorTarget, mutation]
  );

  const onColorChange = useCallback(
    (color: Color) => {
      setValue(color);
      schedulePersist(color);
    },
    [schedulePersist]
  );

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const swatchClass = size === "page" ? styles.swatchPage : styles.swatch;

  return (
    <ColorPicker value={value} onChange={onColorChange}>
      <DialogTrigger
        onOpenChange={(open) => {
          if (!open) flushPending();
        }}
      >
        <Button
          className={styles.trigger}
          aria-label={t("detail.colorPicker.open")}
          onClick={(e) => e.stopPropagation()}
        >
          <ColorSwatch className={swatchClass} />
        </Button>
        <Popover placement="bottom end" className={styles.popover}>
          <Dialog className={styles.dialog}>
            <ColorArea
              className={styles.area}
              colorSpace="hsb"
              xChannel="saturation"
              yChannel="brightness"
            >
              <ColorPickerThumb />
            </ColorArea>
            <ColorSlider
              className={styles.hueSlider}
              colorSpace="hsb"
              channel="hue"
              aria-label={t("detail.colorPicker.hue")}
            >
              <SliderTrack
                className={styles.hueTrack}
                style={({ defaultStyle }) => ({
                  background: `${defaultStyle.background}, repeating-conic-gradient(#ccc 0% 25%, #fff 0% 50%) 50% / 10px 10px`,
                })}
              >
                <ColorPickerThumb />
              </SliderTrack>
            </ColorSlider>
            <div className={styles.hexRow}>
              <ColorSwatch className={styles.previewSwatch} />
              <ColorField className={styles.hexField} aria-label={t("detail.colorPicker.hex")} />
            </div>
            <Button
              type="button"
              className={styles.clearColor}
              aria-label={t("detail.colorPicker.clear")}
              isDisabled={clearMutation.isPending}
              onPress={() => {
                flushPending();
                clearMutation.mutate(colorTarget);
              }}
            >
              <span className={styles.clearIcon} aria-hidden>
                ×
              </span>
            </Button>
          </Dialog>
        </Popover>
      </DialogTrigger>
    </ColorPicker>
  );
}
