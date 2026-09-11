import { useState } from "react";
import {
  embedUrl,
  type MarketingVideo,
} from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";

/**
 * One video on `/videos`.
 *
 * An embed is a FACADE: until the visitor presses play, nothing is requested
 * from YouTube or Vimeo, so an unwatched page sets no third-party cookie. A
 * self-hosted file needs no facade — it is served from our own origin — so it
 * renders a plain `<video controls>` with `preload="none"`, which fetches the
 * poster and not the media.
 *
 * A video with no source at all is not hidden: the card says it is being
 * recorded. An empty page reads as a broken feature; a named gap reads as a
 * plan.
 */
export function VideoCard({
  video,
  t,
}: {
  video: MarketingVideo;
  t: MarketingTranslation;
}) {
  const [playing, setPlaying] = useState(false);
  const copy = t.videos.items[video.id];
  const source = video.source;

  return (
    <article className="mk-card mk-video">
      <div className="mk-video__frame">
        {source === null ? (
          <div className="mk-media__empty mk-video__empty" role="img" aria-label={t.videos.comingSoon}>
            <span className="mk-media__label">{t.videos.comingSoon}</span>
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
            title={copy.title}
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowFullScreen
          />
        ) : (
          <>
            {source.poster ? (
              <img className="mk-video__poster" src={source.poster} alt="" />
            ) : null}
            <button
              type="button"
              className="mk-video__play"
              onClick={() => setPlaying(true)}
            >
              <span>
                <span aria-hidden="true">&#9654;</span>
                {t.videos.loadExternal}
              </span>
            </button>
          </>
        )}
      </div>

      <div className="mk-video__body">
        <h3>{copy.title}</h3>
        <p>{source === null ? t.videos.comingSoonBody : copy.body}</p>
        {source?.kind === "embed" && !playing ? (
          <p className="mk-note">{t.videos.externalNote}</p>
        ) : null}
      </div>
    </article>
  );
}
