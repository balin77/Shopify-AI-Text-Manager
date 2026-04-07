import { json } from "@remix-run/node";
import { getFormString } from "~/utils/form-data.utils";
import type { TemplatesActionContext } from "./shared";

export async function handleLoadTranslations(ctx: TemplatesActionContext): Promise<Response> {
  const { db, session, formData, groupId } = ctx;
  const locale = getFormString(formData, "locale");

  const translations = await db.themeTranslation.findMany({
    where: {
      shop: session.shop,
      groupId: groupId,
      locale: locale,
    },
  });

  return json({
    success: true,
    translations,
    locale,
  });
}
