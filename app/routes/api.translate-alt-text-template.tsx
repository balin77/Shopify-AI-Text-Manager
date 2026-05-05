import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { createAIService } from "./api-ai-handlers/shared";

interface TemplateItem {
  position: number;
  template: string;
}

interface RequestBody {
  templates: TemplateItem[];
  fromLocale: string;
  toLocales: string[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const body: RequestBody = await request.json();
  const { templates, fromLocale, toLocales } = body;

  if (!templates || !fromLocale || !toLocales || toLocales.length === 0) {
    return json({ success: false, error: "templates, fromLocale, toLocales required" }, { status: 400 });
  }

  const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
  const aiService = createAIService(settings, session.shop, "translate-alt-template");

  const result: Record<string, TemplateItem[]> = {};

  for (const locale of toLocales) {
    result[locale] = [];
    for (const tmpl of templates) {
      if (!tmpl.template) {
        result[locale].push({ position: tmpl.position, template: "" });
        continue;
      }
      try {
        const translated = await aiService.translateTemplate(tmpl.template, fromLocale, locale);
        result[locale].push({ position: tmpl.position, template: translated });
      } catch {
        result[locale].push({ position: tmpl.position, template: tmpl.template });
      }
    }
  }

  return json({ success: true, translations: result });
};
