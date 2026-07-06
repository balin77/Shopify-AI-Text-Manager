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

import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "~/shopify.server";
import { getFormString } from "~/utils/form-data.utils";
import { listThemes, resolveSelectedThemeId, setSelectedThemeId } from "~/services/theme-selection.server";

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
  return json({ success: true, selectedThemeId: result.selectedThemeId });
};
