/**
 * A Polaris TextField for a SINGLE-LINE value that wraps and grows instead of
 * scrolling sideways.
 *
 * A one-line `<input>` hid everything past its right edge: a long title, SEO
 * title or handle had to be scrolled inside the box to be read. This renders
 * Polaris' auto-sizing `multiline` textarea (one line minimum: at rest it is the
 * old input's 32px on desktop, 44px with the line centred on touch — see
 * responsive.css) and keeps typing single-line: Enter is cancelled (IME commits
 * excepted) and a NEW line break that still arrives — a paste, a drop, a mobile
 * keyboard that reports no key — becomes a space before `onChange` sees it
 * (`normalizeSingleLineChange`). A value that was ALREADY stored with a break
 * is shown and kept as it is (the old input stripped it on the first
 * keystroke). Spellcheck is off unless the caller asks for it.
 *
 * Use it ONLY for single-line values. A field that is multi-line on purpose
 * (a description, a multi-line metafield) keeps a plain `multiline` TextField.
 *
 * Hydration: Polaris renders the textarea with `rows={1}` and no inline height
 * on the server AND on the first client render (its Resizer only mounts after
 * the initial render), and the suffix inset below is written in an effect, so
 * both sides produce the same tree.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { TextField } from "@shopify/polaris";
import { isLineBreakKey, normalizeSingleLineChange } from "../../utils/single-line-text";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export interface SingleLineTextFieldProps {
  label: ReactNode;
  labelHidden?: boolean;
  value: string;
  onChange?: (value: string) => void;
  onBlur?: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  readOnly?: boolean;
  autoComplete?: string;
  helpText?: ReactNode;
  maxLength?: number;
  placeholder?: string;
  showCharacterCount?: boolean;
  error?: string | boolean;
  suffix?: ReactNode;
  prefix?: ReactNode;
  requiredIndicator?: boolean;
  id?: string;
  /** Off by default: these are names, handles, SEO titles and translations, where a squiggle under every foreign or made-up word is noise. */
  spellCheck?: boolean;
  /** Extra class on the wrapper (the wrapper always carries `app-single-line-autogrow`). */
  className?: string;
}

export function SingleLineTextField({
  label,
  labelHidden,
  value,
  onChange,
  onBlur,
  onFocus,
  disabled,
  readOnly,
  autoComplete = "off",
  helpText,
  maxLength,
  placeholder,
  showCharacterCount,
  error,
  suffix,
  prefix,
  requiredIndicator,
  id,
  spellCheck = false,
  className,
}: SingleLineTextFieldProps) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const hasSideContent = !!suffix || !!prefix || !!showCharacterCount;
  // Polaris' Resizer re-measures only when the TextField renders or the WINDOW
  // resizes. A width change of the field alone (a sidebar drag, a grid
  // reflow, a web font arriving late) re-wraps the text without either, so
  // the box would keep its old height. A width change bumps this tick, which
  // re-renders the TextField and with it the Resizer's measurement.
  const [, setWidthTick] = useState(0);

  useIsomorphicLayoutEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const field = wrapper.querySelector<HTMLElement>(".Polaris-TextField");
    const area = wrapper.querySelector<HTMLTextAreaElement>("textarea");
    if (!field || !area) return;
    // Polaris measures the needed height with a hidden copy of the text that
    // spans the WHOLE field, while the textarea is narrower by the suffix /
    // character count beside it — so a value just short of the field's width
    // would be measured as one line. The difference is handed to the
    // measuring copy as a right inset (responsive.css).
    const updateInset = () => {
      if (!hasSideContent) return;
      const inset = Math.max(0, field.clientWidth - area.offsetWidth);
      wrapper.style.setProperty("--app-autogrow-resizer-inset", `${inset}px`);
    };
    updateInset();
    if (typeof ResizeObserver === "undefined") {
      return () => wrapper.style.removeProperty("--app-autogrow-resizer-inset");
    }
    let fieldWidth = field.clientWidth;
    let areaWidth = area.offsetWidth;
    // Widths only: the height changes this causes must not feed back.
    const observer = new ResizeObserver(() => {
      if (field.clientWidth === fieldWidth && area.offsetWidth === areaWidth) return;
      fieldWidth = field.clientWidth;
      areaWidth = area.offsetWidth;
      updateInset();
      setWidthTick((tick) => tick + 1);
    });
    observer.observe(field);
    observer.observe(area);
    return () => {
      observer.disconnect();
      wrapper.style.removeProperty("--app-autogrow-resizer-inset");
    };
  }, [hasSideContent]);

  const handleKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement | null)?.tagName !== "TEXTAREA") return;
    if (isLineBreakKey(event)) event.preventDefault();
  };

  return (
    <div
      ref={wrapperRef}
      className={`app-single-line-autogrow${className ? ` ${className}` : ""}`}
      onKeyDownCapture={handleKeyDownCapture}
    >
      <TextField
        label={label}
        labelHidden={labelHidden}
        value={value}
        onChange={onChange ? (next) => onChange(normalizeSingleLineChange(next, value)) : undefined}
        onBlur={onBlur}
        onFocus={onFocus}
        disabled={disabled}
        readOnly={readOnly}
        autoComplete={autoComplete}
        helpText={helpText}
        maxLength={maxLength}
        placeholder={placeholder}
        showCharacterCount={showCharacterCount}
        error={error}
        suffix={suffix}
        prefix={prefix}
        requiredIndicator={requiredIndicator}
        id={id}
        spellCheck={spellCheck}
        multiline
      />
    </div>
  );
}
