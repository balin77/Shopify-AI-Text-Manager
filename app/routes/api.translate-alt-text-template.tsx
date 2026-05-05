import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { createAIService } from "./api-ai-handlers/shared";
import { getTaskExpirationDate } from "../config/constants";

interface TemplateItem {
  position: number;
  template: string;
}

interface RequestBody {
  templates: TemplateItem[];
  fromLocale: string;
  toLocales: string[];
  productId?: string;
  productTitle?: string;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ success: false, error: "Method not allowed" }, { status: 405 });
  }

  const { session } = await authenticate.admin(request);
  const body: RequestBody = await request.json();
  const { templates, fromLocale, toLocales, productId, productTitle } = body;

  if (!templates || !fromLocale || !toLocales || toLocales.length === 0) {
    return json({ success: false, error: "templates, fromLocale, toLocales required" }, { status: 400 });
  }

  const totalSteps = toLocales.length * templates.filter((t) => t.template).length;
  const taskType = toLocales.length > 1 ? "bulkTranslation" : "translation";

  const task = await db.task.create({
    data: {
      shop: session.shop,
      type: taskType,
      status: "pending",
      resourceType: "products",
      resourceId: productId ?? "unknown",
      resourceTitle: productTitle ?? productId ?? "Alt Text Template",
      fieldType: "altTextTemplate",
      targetLocale: toLocales.length === 1 ? toLocales[0] : undefined,
      progress: 0,
      expiresAt: getTaskExpirationDate(),
    },
  });

  try {
    await db.task.update({ where: { id: task.id }, data: { status: "running", progress: 10 } });

    const settings = await db.aISettings.findUnique({ where: { shop: session.shop } });
    const aiService = createAIService(settings, session.shop, task.id);

    const result: Record<string, TemplateItem[]> = {};
    let doneSteps = 0;

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
        doneSteps++;
        const progress = Math.round(10 + (doneSteps / Math.max(totalSteps, 1)) * 85);
        await db.task.update({ where: { id: task.id }, data: { progress } });
      }
    }

    await db.task.update({
      where: { id: task.id },
      data: {
        status: "completed",
        progress: 100,
        completedAt: new Date(),
        result: JSON.stringify(result),
      },
    });

    return json({ success: true, translations: result, taskId: task.id });
  } catch (error: unknown) {
    await db.task.update({
      where: { id: task.id },
      data: {
        status: "failed",
        completedAt: new Date(),
        error: (error instanceof Error ? error.message : String(error)).substring(0, 1000),
      },
    });
    throw error;
  }
};
