/**
 * The hand-built twin of `SingleLineTextField`, for the places that draw their
 * own box instead of a Polaris TextField (the image manager's alt-text field).
 *
 * A one-line `<input>` there hid every word past its right edge; this is a
 * `<textarea rows={1}>` that wraps and grows to its content and keeps the value
 * single-line exactly like its Polaris twin: Enter is cancelled outside an IME
 * composition and a NEW line break that still arrives is collapsed to a space
 * (`normalizeSingleLineChange`; a value already stored with a break is kept).
 *
 * Sizing:
 * - It sizes to `value || placeholder`, as Polaris does — in a foreign or
 *   market view the inherited global alt is shown as the PLACEHOLDER, and a
 *   long one must not be cut to one line.
 * - The height is measured on a hidden CLONE placed beside the box, never by
 *   collapsing the box itself to `height: auto`: that shrinks the page for a
 *   moment on every keystroke, which can clamp the scrolling page container's
 *   `scrollTop` and make the page jump.
 * - Re-measured on every value change and every WIDTH change of the box.
 * - Minimum height and vertical padding come from the `app-autogrow-textarea`
 *   class (responsive.css): the button height at rest, 44px with the line
 *   centred on phones and coarse pointers. A class, because an inline
 *   min-height would beat the touch rule.
 *
 * Callers style the box inline as before but set only the HORIZONTAL padding
 * (`paddingLeft`/`paddingRight`); the vertical padding is the class's.
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

/** Writes the height `el` needs for `text` into `el`, measured on a hidden clone beside it. */
function fitToContent(el: HTMLTextAreaElement, text: string) {
  const parent = el.parentNode;
  if (!parent) return;
  const clone = el.cloneNode(false) as HTMLTextAreaElement;
  clone.removeAttribute("id");
  clone.removeAttribute("name");
  clone.setAttribute("aria-hidden", "true");
  clone.tabIndex = -1;
  clone.value = text;
  const style = clone.style;
  style.position = "absolute";
  style.visibility = "hidden";
  style.pointerEvents = "none";
  style.left = "-10000px";
  style.top = "0";
  style.flex = "none";
  style.width = `${el.offsetWidth}px`;
  style.minWidth = "0";
  style.height = "auto";
  parent.insertBefore(clone, el.nextSibling);
  const borders = clone.offsetHeight - clone.clientHeight;
  const needed = clone.scrollHeight + borders;
  parent.removeChild(clone);
  const next = `${needed}px`;
  if (el.style.height !== next) el.style.height = next;
}

export function AutoGrowTextarea({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  className,
  spellCheck = false,
  style,
  ...rest
}: AutoGrowTextareaProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const sizingText = value || placeholder || "";

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    fitToContent(el, sizingText);
    if (typeof ResizeObserver === "undefined") return;
    // A narrower box wraps into more lines: re-fit when the WIDTH changes
    // (our own height writes are ignored, or this would loop).
    let lastWidth = el.offsetWidth;
    const observer = new ResizeObserver(() => {
      if (el.offsetWidth === lastWidth) return;
      lastWidth = el.offsetWidth;
      fitToContent(el, sizingText);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [sizingText]);

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
      placeholder={placeholder}
      spellCheck={spellCheck}
      className={`app-autogrow-textarea${className ? ` ${className}` : ""}`}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      style={{
        resize: "none",
        overflowX: "hidden",
        overflowY: "auto",
        overflowWrap: "break-word",
        lineHeight: "20px",
        fontFamily: "inherit",
        ...style,
      }}
    />
  );
}
