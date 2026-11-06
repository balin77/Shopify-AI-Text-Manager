/**
 * The calm notice for a request our rate limiter held up (see
 * app/utils/rate-limit-retry.ts). No UI of its own: it speaks through the
 * app's existing message strip, in the merchant's language, and stays quiet
 * for waits too short to notice.
 */
import { useEffect, useRef } from "react";
import { useI18n } from "../contexts/I18nContext";
import { useInfoBox } from "../contexts/InfoBoxContext";
import { setRateLimitMessage, subscribeRateLimitEvents } from "../utils/rate-limit-retry";

const DEDUPE_KEY = "rate-limit";
/** A wait shorter than this is not worth a message. */
const MIN_NOTICE_SECONDS = 3;
/** Never more than one message of a kind in this time. */
const MIN_GAP_MS = 15_000;

export function RateLimitNotice() {
  const { t } = useI18n();
  const { showInfoBox } = useInfoBox();
  const last = useRef<{ waiting: number; gaveUp: number }>({ waiting: 0, gaveUp: 0 });
  const waitingText = t.common?.rateLimitWaiting || "The app is busy for a moment. Your request continues automatically.";
  const gaveUpText = t.common?.rateLimitGaveUp || "The app is very busy right now, so this could not be completed. Please check your last change and try again in a minute.";

  useEffect(() => {
    // Also the sentence a refused request's synthesized answer carries as `error`.
    setRateLimitMessage(() => gaveUpText);
    return subscribeRateLimitEvents((event) => {
      const now = Date.now();
      if (event.type === "waiting") {
        if (event.seconds < MIN_NOTICE_SECONDS || now - last.current.waiting < MIN_GAP_MS) return;
        last.current.waiting = now;
        showInfoBox(waitingText, "info", undefined, DEDUPE_KEY);
      } else {
        // A read that was given up changed nothing: "check your last change" would
        // send the merchant looking for a problem that is not there.
        if (!event.write) return;
        if (now - last.current.gaveUp < MIN_GAP_MS) return;
        last.current.gaveUp = now;
        showInfoBox(gaveUpText, "warning", undefined, DEDUPE_KEY);
      }
    });
  }, [waitingText, gaveUpText, showInfoBox]);

  return null;
}
