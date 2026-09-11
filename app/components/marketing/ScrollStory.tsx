import { useEffect, useRef, useState } from "react";
import type { MarketingImageSlot } from "../../config/marketing-images";
import type { MarketingTranslation } from "../../i18n/marketing";
import { MediaSlot } from "./MediaSlot";

export interface StoryStep {
  slot: MarketingImageSlot;
  title: string;
  body: string;
}

/**
 * Text that scrolls past ONE picture that changes with it.
 *
 * The steps run down the left; the browser frame on the right is sticky and
 * cross-fades to the step that is currently in the middle of the viewport.
 * The image changes BECAUSE the text changes — that is what makes the effect
 * an explanation rather than decoration, and why it lives on the three
 * pillars and nowhere else.
 *
 * Three rules keep it honest:
 *
 * - The server renders step 0 active and the client starts from the same
 *   state; the observer only ever runs after hydration (useEffect). No
 *   `typeof window` guard — that flips too early and mismatches anyway.
 * - Below the desktop breakpoint the sticky column is `display: none` and
 *   each step shows its own image inline: sticky on a phone means a picture
 *   that covers the words it belongs to. Both sets are in the DOM; the hidden
 *   one costs no requests because its images are lazy and never laid out.
 * - The fade is opacity only and is switched off under prefers-reduced-motion
 *   (see marketing.css). Nothing here moves the layout.
 */
export function ScrollStory({ steps, t }: { steps: StoryStep[]; t: MarketingTranslation }) {
  const [active, setActive] = useState(0);
  const stepRefs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

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
    return () => observer.disconnect();
  }, []);

  return (
    <div className="mk-story">
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
              <MediaSlot slot={step.slot} t={t} />
            </div>
          </article>
        ))}
      </div>

      <div className="mk-story__visual" aria-hidden="true">
        <div className="mk-story__stack">
          {steps.map((step, index) => (
            <div
              key={step.slot}
              className="mk-story__frame"
              data-active={index === active ? "true" : undefined}
            >
              <MediaSlot slot={step.slot} t={t} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
