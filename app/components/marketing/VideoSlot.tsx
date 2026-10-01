import { HOME_VIDEOS, type HomeVideoSlot } from "../../config/marketing-videos";
import type { MarketingTranslation } from "../../i18n/marketing";
import { VideoFrame } from "./VideoFrame";

/**
 * One video position on the home page, in the same browser-window frame the
 * image slots use, so a recorded video and the "video follows" placeholder
 * have the same size and silhouette and publishing one moves nothing.
 */
export function VideoSlot({
  slot,
  title,
  t,
  paused,
}: {
  slot: HomeVideoSlot;
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
      <VideoFrame source={HOME_VIDEOS[slot]} title={title} pendingLabel={t.video.pending} t={t} paused={paused} />
    </figure>
  );
}
