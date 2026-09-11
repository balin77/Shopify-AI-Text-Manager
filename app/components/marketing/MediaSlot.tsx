import { MARKETING_IMAGES, type MarketingImageSlot } from "../../config/marketing-images";
import type { MarketingTranslation } from "../../i18n/marketing";

/**
 * One image position on the website — the real screenshot once it exists,
 * a placeholder until then.
 *
 * The placeholder is drawn as a browser window (title bar with three dots,
 * an empty page below) rather than as a grey box: the finished page will show
 * screenshots of the app in exactly this frame, so the placeholder already
 * has the proportions and the silhouette of the final thing, and the layout
 * can be judged before a single file exists. The same frame wraps the real
 * image later, so swapping one in changes nothing around it.
 *
 * `aspect` keeps the box's shape stable while the slot is empty; it is
 * overridden by the image's own intrinsic size once one is configured.
 */
export function MediaSlot({
  slot,
  t,
  aspect = "16 / 10",
  className = "",
}: {
  slot: MarketingImageSlot;
  t: MarketingTranslation;
  aspect?: string;
  className?: string;
}) {
  const image = MARKETING_IMAGES[slot];

  return (
    <figure className={`mk-media ${className}`.trim()}>
      <div className="mk-media__bar" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      {image ? (
        <img
          className="mk-media__img"
          src={image.src}
          width={image.width}
          height={image.height}
          alt={t.media.alt[slot]}
          loading={slot === "hero" ? "eager" : "lazy"}
          decoding="async"
        />
      ) : (
        <div className="mk-media__empty" style={{ aspectRatio: aspect }} role="img" aria-label={t.media.placeholder}>
          <span className="mk-media__label">{t.media.placeholder}</span>
        </div>
      )}
    </figure>
  );
}
