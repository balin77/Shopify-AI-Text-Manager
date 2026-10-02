/**
 * The message text of the navigation's InfoBox strip, sized so the strip never
 * changes height (see `info-box-fit.ts` for the rule).
 *
 * It measures the message on one line at the normal size with an invisible
 * copy and compares that with the width its box actually has; a message that
 * does not fit is drawn compact (smaller font, two clamped lines). Measured in
 * a layout effect — before paint, so a long message never flashes at the
 * normal size — and again whenever the box's width changes.
 *
 * Hydration: the first render is always the "single" mode on both sides; the
 * mode only moves in the effect.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { INFO_BOX_COMPACT, INFO_BOX_NORMAL, infoBoxFitMode } from "../utils/info-box-fit";
import type { InfoBoxFitMode } from "../utils/info-box-fit";

const useIsomorphicLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export function InfoBoxMessageText({ message }: { message: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [mode, setMode] = useState<InfoBoxFitMode>("single");

  useIsomorphicLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure) return;
    const fit = () => {
      setMode(infoBoxFitMode(measure.getBoundingClientRect().width, box.clientWidth));
    };
    fit();
    // A web font arriving late changes the message's natural width without
    // touching the box: re-measure then too.
    let cancelled = false;
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    const onFontsLoaded = () => {
      if (!cancelled) fit();
    };
    fonts?.ready.then(onFontsLoaded).catch(() => {});
    fonts?.addEventListener?.("loadingdone", onFontsLoaded);
    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      // The box's WIDTH and the measuring copy's width are the inputs. The
      // mode changes the text's font size and therefore the box's HEIGHT
      // (one 20px line or two 15px lines), and a height change can fire this
      // observer too — harmless: the decision reads widths only, the copy is
      // always at the normal size, so a repeat answers the same mode.
      observer = new ResizeObserver(fit);
      observer.observe(box);
      observer.observe(measure);
    }
    return () => {
      cancelled = true;
      observer?.disconnect();
      fonts?.removeEventListener?.("loadingdone", onFontsLoaded);
    };
  }, [message]);

  const size = mode === "compact" ? INFO_BOX_COMPACT : INFO_BOX_NORMAL;

  return (
    <div
      ref={boxRef}
      data-fit={mode}
      style={{ position: "relative", flex: 1, minWidth: 0, overflow: "hidden" }}
    >
      <span
        title={message}
        style={{
          color: "var(--p-color-text)",
          fontSize: `${size.fontSizePx}px`,
          lineHeight: `${size.lineHeightPx}px`,
          // A message can carry a GID, a URL or a raw GraphQL error. Without a
          // break rule one long token stretched the strip.
          overflowWrap: "anywhere",
          // Two lines at most (one in practice at the normal size), then an
          // ellipsis; the full text is in the title and in the bell.
          display: "-webkit-box",
          WebkitBoxOrient: "vertical",
          WebkitLineClamp: mode === "compact" ? 2 : 1,
          overflow: "hidden",
        }}
      >
        {message}
      </span>
      {/* The measuring copy: one line at the NORMAL size, invisible and out of
          the flow, so the decision never depends on the mode it decides. */}
      <span
        ref={measureRef}
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          visibility: "hidden",
          pointerEvents: "none",
          whiteSpace: "nowrap",
          fontSize: `${INFO_BOX_NORMAL.fontSizePx}px`,
          lineHeight: `${INFO_BOX_NORMAL.lineHeightPx}px`,
        }}
      >
        {message}
      </span>
    </div>
  );
}
