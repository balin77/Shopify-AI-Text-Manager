/**
 * Theme-Auswahl (Theme Selection) — server helpers.
 *
 * Central place that answers "which theme are theme-bezogene Inhalte
 * (Templates / Theme-Settings / Locale-Content) edited/translated against?".
 *
 * Persistence: AISettings.selectedThemeId (per shop, null = automatically the
 * published/MAIN theme). resolveSelectedThemeId() validates the stored choice
 * against the live theme list on every call, so a deleted/deinstalled theme
 * transparently falls back to MAIN (see PLAN_THEME_SELECTION §5.1, §9.1).
 */

import { GET_THEMES } from "~/graphql/content.queries";
import { db } from "~/db.server";
import { logger } from "~/utils/logger.server";

export interface ThemeOption {
  /** Shopify Theme-GID, e.g. gid://shopify/OnlineStoreTheme/123. */
  id: string;
  name: string;
  /** MAIN | UNPUBLISHED | DEMO | DEVELOPMENT | ARCHIVED | … */
  role: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

/**
 * List the shop's installed themes via GET_THEMES. Returns [] on API error so
 * callers can degrade gracefully (dropdown hidden / MAIN fallback).
 */
export async function listThemes(admin: Admin): Promise<ThemeOption[]> {
  try {
    const resp = await admin.graphql(GET_THEMES, { variables: { first: 50 } });
    const data = await resp.json();
    const edges: Array<{ node: { id: string; name: string; role: string } }> =
      data?.data?.themes?.edges ?? [];
    return edges.map((e) => ({ id: e.node.id, name: e.node.name, role: e.node.role }));
  } catch (error) {
    logger.error("[ThemeSelection] Failed to list themes", {
      context: "ThemeSelection",
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/** The MAIN (published) theme's GID from a theme list, or the first theme, or null. */
export function pickMainThemeId(themes: ThemeOption[]): string | null {
  const main = themes.find((t) => String(t.role).toUpperCase() === "MAIN");
  return main?.id ?? themes[0]?.id ?? null;
}

/**
 * Resolve the theme to operate on for a shop:
 *   1. AISettings.selectedThemeId, if set AND still present in the live list.
 *   2. otherwise the MAIN (published) theme.
 *   3. otherwise the first theme, else null (no themes at all).
 *
 * Pass a pre-fetched `themes` list to avoid a second GET_THEMES round-trip when
 * the caller already has one (e.g. a loader that also renders the dropdown).
 */
export async function resolveSelectedThemeId(
  shop: string,
  admin: Admin,
  themes?: ThemeOption[],
): Promise<string | null> {
  const themeList = themes ?? (await listThemes(admin));

  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { selectedThemeId: true },
  });
  const stored = settings?.selectedThemeId ?? null;

  if (stored && themeList.some((t) => t.id === stored)) {
    return stored;
  }
  return pickMainThemeId(themeList);
}

/**
 * Persist the merchant's theme choice. Validates against the live theme list;
 * only an existing theme id is accepted. Passing null clears the choice
 * (→ MAIN fallback). Returns the value actually stored.
 *
 * AISettings has `shop @unique` but no other required columns without defaults,
 * so an upsert with an empty create is safe for a shop that has no row yet.
 */
export async function setSelectedThemeId(
  shop: string,
  admin: Admin,
  themeId: string | null,
): Promise<{ ok: boolean; selectedThemeId: string | null; error?: string }> {
  let value: string | null = null;
  if (themeId) {
    const themes = await listThemes(admin);
    if (!themes.some((t) => t.id === themeId)) {
      return { ok: false, selectedThemeId: null, error: "Unknown theme id" };
    }
    value = themeId;
  }

  await db.aISettings.upsert({
    where: { shop },
    create: { shop, selectedThemeId: value },
    update: { selectedThemeId: value },
  });

  return { ok: true, selectedThemeId: value };
}
