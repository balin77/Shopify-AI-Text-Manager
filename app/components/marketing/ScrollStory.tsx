import { useEffect, useRef, useState } from "react";
import type { HomeVideoSlot } from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";
import { VideoSlot } from "./VideoSlot";

export interface StoryStep {
  slot: HomeVideoSlot;
  title: string;
  body: string;
}

/**
 * Text that scrolls past ONE video frame that changes with it.
 *
 * The steps run down the left; the browser frame on the right is sticky and
 * cross-fades to the step that is currently in the middle of the viewport.
 * The video changes BECAUSE the text changes — that is what makes the effect
 * an explanation rather than decoration, and why it lives on the three
 * pillars and nowhere else.
 *
 * Three rules keep it honest:
 *
 * - The server renders step 0 active and the client starts from the same
 *   state; the observer only ever runs after hydration (useEffect). No
 *   `typeof window` guard — that flips too early and mismatches anyway.
 * - Below the desktop breakpoint — and everywhere until the effect has
 *   stamped `data-enhanced` — the sticky column is `display: none` and each
 *   step shows its own video inline: sticky on a phone means a frame that
 *   covers the words it belongs to. On desktop the inline copies leave the
 *   page entirely and the sticky column is the one a visitor (and a screen
 *   reader) reaches: a player is a control, and a visually hidden copy of it
 *   would be a tab stop nobody can see. Inactive frames are `visibility:
 *   hidden` once faded, which takes them out of the tab order too, and a
 *   frame that fades out stops its video.
 * - The fade is opacity only and is switched off under prefers-reduced-motion
 *   (see marketing.css). Nothing here moves the layout.
 */
export function ScrollStory({ steps, t }: { steps: StoryStep[]; t: MarketingTranslation }) {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<Array<HTMLElement | null>>([]);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    // Progressive enhancement, made explicit: the sticky layout and the
    // dimming of inactive steps exist only once this effect runs. Without
    // it — no JavaScript, a failed hydration, a reader-mode fetch — the CSS
    // keeps every step at full opacity with its own image inline, which is
    // the mobile layout and reads fine at any width. The first cut dimmed in
    // CSS unconditionally, so steps 2 and 3 were ~1.7:1 forever for exactly
    // those visitors.
    const root = rootRef.current;
    if (root) root.dataset.enhanced = "true";

    // A step is "current" while it crosses the middle band of the viewport.
    // The 45% margins shrink the root to that band, so at most one or two
    // steps intersect at a time and the LAST intersecting one wins — that
    // is the one the reader has scrolled furthest into.
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .map((entry) => Number((entry.target as HTMLElement).dataset.step));
        if (visible.length > 0) setActive(Math.max(...visible));
      },
      { rootMargin: "-45% 0px -45% 0px", threshold: 0 },
    );

    for (const el of stepRefs.current) if (el) observer.observe(el);
    return () => {
      observer.disconnect();
      if (root) delete root.dataset.enhanced;
    };
  }, []);

  return (
    <div className="mk-story" ref={rootRef}>
      <div className="mk-story__steps">
        {steps.map((step, index) => (
          <article
            key={step.slot}
            className="mk-story__step"
            data-step={index}
            data-active={index === active ? "true" : undefined}
            ref={(el) => {
              stepRefs.current[index] = el;
            }}
          >
            <span className="mk-story__index" aria-hidden="true">
              {String(index + 1).padStart(2, "0")}
            </span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
            <div className="mk-story__inline">
              <VideoSlot slot={step.slot} title={step.title} t={t} />
            </div>
          </article>
        ))}
      </div>

      <div className="mk-story__visual">
        <div className="mk-story__stack">
          {steps.map((step, index) => (
            <div
              key={step.slot}
              className="mk-story__frame"
              data-active={index === active ? "true" : undefined}
            >
              <VideoSlot slot={step.slot} title={step.title} t={t} paused={index !== active} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
