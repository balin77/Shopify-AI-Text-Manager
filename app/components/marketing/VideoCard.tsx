import type { MarketingVideo } from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";
import { VideoFrame } from "./VideoFrame";

/**
 * One video on `/videos`. The frame — and with it the click-to-load facade
 * that keeps an unwatched page free of third-party cookies — is `VideoFrame`,
 * shared with the guide's topic pages.
 */
export function VideoCard({
  video,
  t,
}: {
  video: MarketingVideo;
  t: MarketingTranslation;
}) {
  const copy = t.videos.items[video.id];
  const source = video.source;

  return (
    <article className="mk-card mk-video">
      <VideoFrame source={source} title={copy.title} pendingLabel={t.videos.comingSoon} t={t} />

      <div className="mk-video__body">
        <h3>{copy.title}</h3>
        <p>{source === null ? t.videos.comingSoonBody : copy.body}</p>
        {source?.kind === "embed" ? <p className="mk-note">{t.videos.externalNote}</p> : null}
      </div>
    </article>
  );
}
