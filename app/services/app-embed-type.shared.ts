/**
 * Whether an app-embed block `type` belongs to OUR app. The app-handle segment
 * of `shopify://apps/<app-handle>/blocks/...` carries our handle (e.g.
 * "contentpilot-ai" in prod, "contentpilot-ai-dev" in dev — both contain
 * "contentpilot"). Matching the authoritative handle (not the lossy display
 * name) keeps other apps' embeds editable while locking ours. Normalized so
 * handle punctuation/casing variants still match.
 *
 * Import-free so client-safe and pure readers (embed-status.shared.ts) can use
 * it without pulling the background sync into their graph; the sync re-exports
 * it from here.
 */
export function isOwnAppEmbedType(type: unknown): boolean {
  if (typeof type !== "string") return false;
  const m = type.match(/^shopify:\/\/apps\/([^/]+)\/blocks\//);
  if (!m) return false;
  return m[1].toLowerCase().replace(/[^a-z0-9]/g, "").includes("contentpilot");
}
