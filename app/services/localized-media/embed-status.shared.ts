/**
 * Is the `localized-media` app embed switched on in a theme? Pure and
 * import-free: it reads the TEXT of the theme's `config/settings_data.json`.
 *
 * Three answers, never two: `true` (an embed entry of that block exists and is
 * not disabled), `false` (the file parsed and holds no enabled entry) and
 * `null` (unknown: no file, unparseable, or a shape this reader does not know).
 * Only `true` may silence the "turn on the app embed" reminder - an unknown
 * state keeps it, because a missing reminder is the costly direction.
 *
 * ASSUMED, not measured with a probe: app embeds sit under `current.blocks` as
 * `{ type: "shopify://apps/<app>/blocks/<block>/<uuid>", disabled?: boolean }`.
 * The app-embed name map in background-sync.service.ts already reads that same
 * shape. The block is matched by its HANDLE and by the APP: the app segment is
 * our app's handle (it differs between the dev and prod apps, so it is
 * recognised by `isOwnAppEmbedType`, the predicate the theme sync locks our own
 * embeds with). That recognition is not measured either, so it is used only
 * where it can decide: a `localized-media` block whose app is recognised as ours
 * answers; where the file shows another embed of OURS but no `localized-media`
 * block of ours, a same-named block belongs to another app and does not count;
 * and where no embed in the file is recognisably ours (our handle unknown here),
 * the handle alone decides, as before.
 */
import { isOwnAppEmbedType } from "../app-embed-type.shared";

export const LOCALIZED_MEDIA_EMBED_HANDLE = "localized-media";

const EMBED_TYPE = /^shopify:\/\/apps\/[^/]+\/blocks\/([^/]+)\//;

/** settings_data.json starts with a banner comment that is not JSON. */
function stripLeadingComment(raw: string): string {
  return raw.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, "");
}

export function appEmbedActiveInSettingsData(
  raw: string | null | undefined,
  handle: string = LOCALIZED_MEDIA_EMBED_HANDLE,
): boolean | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripLeadingComment(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const current = (parsed as { current?: unknown }).current;
  // Older themes may store a preset NAME here; that is not a shape we can read.
  if (!current || typeof current !== "object") return null;
  const blocks = (current as { blocks?: unknown }).blocks;
  if (blocks === undefined || blocks === null) return false; // no embed was ever turned on
  if (typeof blocks !== "object" || Array.isArray(blocks)) return null;
  let ownAppKnown = false;
  let ownMatch = false;
  let ownEnabled = false;
  let anyEnabled = false;
  for (const block of Object.values(blocks as Record<string, unknown>)) {
    if (!block || typeof block !== "object") continue;
    const type = (block as { type?: unknown }).type;
    if (typeof type !== "string") continue;
    const own = isOwnAppEmbedType(type);
    if (own) ownAppKnown = true;
    const m = type.match(EMBED_TYPE);
    if (!m || m[1] !== handle) continue;
    const enabled = (block as { disabled?: unknown }).disabled !== true;
    if (own) {
      ownMatch = true;
      if (enabled) ownEnabled = true;
    }
    if (enabled) anyEnabled = true;
  }
  if (ownMatch) return ownEnabled;
  // Our handle is recognisable in this file, and none of its blocks is ours:
  // a same-named embed is another app's.
  if (ownAppKnown) return false;
  return anyEnabled;
}
