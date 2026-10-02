/**
 * The hand-built twin of `SingleLineTextField`, for the places that draw their
 * own box instead of a Polaris TextField (the image manager's alt-text field).
 *
 * A one-line `<input>` there hid every word past its right edge; this is a
 * `<textarea rows={1}>` that wraps and grows to its content (scrollHeight
 * measured on every value change and every width change) and keeps the value
 * single-line exactly like its Polaris twin: Enter is cancelled outside an IME
 * composition and a line break that still arrives is collapsed to a space
 * (`normalizeSingleLineChange`). Its minimum height is `--app-control-height`,
 * the height of the input it replaces, so nothing moves on load.
 *
 * Every other prop (style, focus/blur handlers, readOnly, title, placeholder…)
 * is passed straight through, so the call site keeps its own look.
 *
 * Hydration: the server and the first client render both produce a plain
 * `rows={1}` textarea; the measured height is written to the element in a
 * layout effect, never through React state.
 */
import { useEffect, useLayoutEffect, useRef } from "react";
import type { ChangeEvent, KeyboardEvent, TextareaHTMLAttributes } from "react";
import { isLineBreakKey, normalizeSingleLineChange } from "../../utils/single-line-text";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export interface AutoGrowTextareaProps
  extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange" | "rows"> {
  value: string;
  /** Receives the line-break-free value (see `normalizeSingleLineChange`). */
  onValueChange?: (value: string) => void;
}

export function AutoGrowTextarea({
  value,
  onValueChange,
  onKeyDown,
  style,
  ...rest
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      // Reset first so the measurement reflects the CURRENT content, not the
      // previously written height (or deleting text would never shrink it).
      el.style.height = "auto";
      const borders = el.offsetHeight - el.clientHeight;
      el.style.height = `${el.scrollHeight + borders}px`;
    };
    fit();
    if (typeof ResizeObserver === "undefined") return;
    // A narrower box wraps into more lines: re-fit when the WIDTH changes
    // (our own height writes are ignored, or this would loop).
    let lastWidth = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === lastWidth) return;
      lastWidth = el.clientWidth;
      fit();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [value]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isLineBreakKey(event)) event.preventDefault();
    onKeyDown?.(event);
  };

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    onValueChange?.(normalizeSingleLineChange(event.target.value, value));
  };

  return (
    <textarea
      {...rest}
      ref={ref}
      rows={1}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      style={{
        boxSizing: "border-box",
        minHeight: "var(--app-control-height)",
        resize: "none",
        overflow: "hidden",
        overflowWrap: "break-word",
        lineHeight: "20px",
        fontFamily: "inherit",
        ...style,
      }}
    />
  );
}
