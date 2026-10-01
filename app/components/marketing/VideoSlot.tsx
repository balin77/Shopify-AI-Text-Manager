import { SITE_VIDEOS, type SiteVideoSlot } from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";
import { VideoFrame } from "./VideoFrame";

/**
 * One video position on the website, in a browser-window frame, so a recorded
 * video and the "video follows" placeholder have the same size and
 * silhouette and publishing one moves nothing.
 */
export function VideoSlot({
  slot,
  title,
  t,
  paused,
}: {
  slot: SiteVideoSlot;
  /** The player's accessible name once an embed is loaded. */
  title: string;
  t: MarketingTranslation;
  paused?: boolean;
}) {
  return (
    <figure className="mk-media">
      <div className="mk-media__bar" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <VideoFrame source={SITE_VIDEOS[slot]} title={title} pendingLabel={t.video.pending} t={t} paused={paused} />
    </figure>
  );
}
