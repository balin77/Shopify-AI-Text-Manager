/**
 * API Route: Theme-Auswahl (Theme Selection)
 *
 * POST /api/select-theme  { themeId }
 *   Persists AISettings.selectedThemeId for the current shop. An empty/"auto"
 *   themeId clears the choice (→ MAIN fallback). The value is validated against
 *   the live theme list before it is stored.
 *
 * The loader responds with the current theme list + resolved selection so the
 * client can populate the dropdown without a second endpoint.
 */

import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { data as json } from "react-router";
import { authenticate } from "~/shopify.server";
import { getFormString } from "~/utils/form-data.utils";
import { listThemes, resolveSelectedThemeId, setSelectedThemeId, getCachedThemes, pickMainThemeId } from "~/services/theme-selection.server";
import { logger } from "~/utils/logger.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!session) return json({ success: false, error: "Unauthorized" }, { status: 401 });

  const themes = await listThemes(admin);
  const selectedThemeId = await resolveSelectedThemeId(session.shop, admin, themes);
  return json({ success: true, themes, selectedThemeId });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  if (!session) return json({ success: false, error: "Unauthorized" }, { status: 401 });

  const formData = await request.formData();
  const raw = getFormString(formData, "themeId");
  // Empty string or the sentinel "auto" clears the choice (MAIN fallback).
  const themeId = !raw || raw === "auto" ? null : raw;

  const result = await setSelectedThemeId(session.shop, admin, themeId);
  if (!result.ok) {
    return json({ success: false, error: result.error ?? "Invalid theme" }, { status: 400 });
  }

  // C.2 (PLAN_THEME_SELECTION_B_LITE): auto-populate a freshly-selected NON-MAIN
  // theme in the BACKGROUND so its content appears without a manual "sync now".
  // Fire-and-forget: the switch response returns immediately; the editor's
  // needsThemeSync banner shows meanwhile and a later revalidate surfaces the
  // content. No-op for MAIN (covered by the full sync) or a theme already synced.
  const selected = result.selectedThemeId;
  if (selected) {
    void (async () => {
      try {
        const { db } = await import("~/db.server");
        const themes = await getCachedThemes(admin, session.shop);
        if (selected === pickMainThemeId(themes)) return;
        const own = await db.themeContent.count({ where: { shop: session.shop, domain: "theme", themeId: selected } });
        if (own > 0) return;
        const { BackgroundSyncService } = await import("~/services/background-sync.service");
        await new BackgroundSyncService(admin, session.shop).syncTheme(selected);
      } catch (e) {
        logger.warn("[SELECT-THEME] background theme sync failed (non-fatal; manual sync remains)", {
          context: "SelectTheme",
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
  }

  return json({ success: true, selectedThemeId: result.selectedThemeId });
};
