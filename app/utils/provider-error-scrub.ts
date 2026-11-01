import { redactString } from "./sentry-scrub";

/**
 * A provider's error text, made safe to log or store: known credential shapes
 * go through the shared Sentry scrubber, and any long opaque token (an API key,
 * or the fragment a provider echoes back such as OpenAI's "Incorrect API key
 * provided: sk-…") is masked on top. Bounded, so a provider answering with a
 * page of HTML cannot flood a log line or a `Task.error` column.
 *
 * Applied at the SOURCE (the `InvalidAIKeyError` constructor): the error is
 * logged and written to `Task.error` by several handlers, and a scrub that only
 * the one route applied would leave every other reader with the raw text.
 */
export function scrubProviderErrorText(text: string): string {
  const scrubbed = String(redactString(text));
  return scrubbed.replace(/[A-Za-z0-9_\-.]{20,}/g, "[redacted-token]").slice(0, 500);
}
