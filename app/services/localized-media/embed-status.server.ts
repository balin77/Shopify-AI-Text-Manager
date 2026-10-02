/**
 * Reads whether the `localized-media` app embed is on in the shop's MAIN theme,
 * so the product page can leave out the "turn on the embed" reminder once it is.
 *
 * Never throws: every failure is `null` (unknown), which keeps the reminder.
 * Cached per shop for two minutes so the products page does not read the
 * theme file on every load; a merchant who just activated the embed through
 * the link sees the reminder disappear within that window. Only a KNOWN answer
 * is cached - an unknown one is asked again on the next load.
 */
import { getMainThemeId, readThemeFile } from "../seo/aeo.service";
import { appEmbedActiveInSettingsData } from "./embed-status.shared";

const TTL_MS = 2 * 60 * 1000;
const cache = new Map<string, { value: boolean; at: number }>();

type Admin = Parameters<typeof getMainThemeId>[0];

export async function getLocalizedMediaEmbedActive(admin: Admin, shop: string): Promise<boolean | null> {
  const hit = cache.get(shop);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  try {
    const themeId = await getMainThemeId(admin);
    if (!themeId) return null;
    const raw = await readThemeFile(admin, themeId, "config/settings_data.json");
    const value = appEmbedActiveInSettingsData(raw);
    if (value !== null) cache.set(shop, { value, at: Date.now() });
    return value;
  } catch {
    return null;
  }
}

/** Test seam. */
export function clearLocalizedMediaEmbedCache(): void {
  cache.clear();
}
