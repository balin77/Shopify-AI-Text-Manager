import { useState } from "react";
import { embedUrl, type MarketingVideoSource } from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";

/**
 * The 16:9 frame of one video, used by the guide's topic pages. Any other
 * page that shows a video renders this too, so the click-to-load rule lives in
 * exactly one place.
 *
 * An embed is a FACADE: until the visitor presses play, nothing is requested
 * from YouTube or Vimeo, so an unwatched page sets no third-party cookie. A
 * self-hosted file needs no facade — it is served without a third party — so
 * it renders a plain `<video controls>` with `preload="none"`, which fetches
 * the poster and not the media.
 *
 * A missing source is not hidden: the frame names the gap (`pendingLabel`).
 * An empty page reads as a broken feature; a named gap reads as a plan.
 */
export function VideoFrame({
  source,
  title,
  pendingLabel,
  t,
}: {
  source: MarketingVideoSource | null;
  /** The iframe's accessible name once an embed is loaded. */
  title: string;
  pendingLabel: string;
  t: MarketingTranslation;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="mk-video__frame">
      {source === null ? (
        <div className="mk-media__empty mk-video__empty" role="img" aria-label={pendingLabel}>
          <span className="mk-media__label">{pendingLabel}</span>
        </div>
      ) : source.kind === "file" ? (
        <video controls preload="none" poster={source.poster} playsInline>
          {source.sources.map((entry) => (
            <source key={entry.src} src={entry.src} type={entry.type} />
          ))}
        </video>
      ) : playing ? (
        <iframe
          src={embedUrl(source)}
          title={title}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      ) : (
        <>
          {source.poster ? <img className="mk-video__poster" src={source.poster} alt="" /> : null}
          <button type="button" className="mk-video__play" onClick={() => setPlaying(true)}>
            <span>
              <span aria-hidden="true">&#9654;</span>
              {t.video.loadExternal}
            </span>
          </button>
        </>
      )}
    </div>
  );
}
