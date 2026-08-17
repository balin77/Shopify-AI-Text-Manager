import { data as json } from "react-router";
import { getFormString } from "~/utils/form-data.utils";
import type { TemplatesActionContext } from "./shared";
import type { DataResponse } from "~/types/data-response";

export async function handleLoadTranslations(ctx: TemplatesActionContext): Promise<DataResponse> {
  const { db, session, formData, groupId, domain, selectedThemeId } = ctx;
  const locale = getFormString(formData, "locale");

  const translations = await db.themeTranslation.findMany({
    where: {
      shop: session.shop,
      groupId: groupId,
      locale: locale,
      domain: domain,
      // Theme-Auswahl: scope to the selected theme; legacy/flat rows (themeId "")
      // stay visible via the compat-OR.
      ...(selectedThemeId ? { OR: [{ themeId: selectedThemeId }, { themeId: "" }] } : {}),
    },
  });

  return json({
    success: true,
    translations,
    locale,
  });
}
