import { data as json, type LoaderFunctionArgs, type ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const productId = url.searchParams.get("productId") ?? null;

  if (!productId) {
    return json({ error: "productId required" }, { status: 400 });
  }

  const templates = await db.altTextTemplate.findMany({
    where: { shop: session.shop, productId },
    orderBy: [{ position: "asc" }, { locale: "asc" }],
  });

  return json(
    templates.map((t) => ({
      id: t.id,
      position: t.position,
      positionLabel: t.positionLabel ?? "",
      locale: t.locale,
      template: t.template,
    }))
  );
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  if (request.method === "DELETE") {
    const url = new URL(request.url);
    const productId = url.searchParams.get("productId");
    const positionRaw = url.searchParams.get("position");

    if (!productId) {
      return json({ success: false, error: "productId required" }, { status: 400 });
    }
    if (positionRaw === null) {
      return json({ success: false, error: "position required" }, { status: 400 });
    }
    const position = parseInt(positionRaw, 10);

    await db.altTextTemplate.deleteMany({
      where: { shop: session.shop, productId, position },
    });

    return json({ success: true });
  }

  if (request.method === "POST") {
    const body = await request.json() as {
      productId?: string | null;
      position: number;
      positionLabel?: string;
      locale: string;
      template: string;
    };

    const { position, positionLabel, locale, template } = body;
    const productId = body.productId;

    if (!productId) {
      return json({ success: false, error: "productId required" }, { status: 400 });
    }

    const row = await db.altTextTemplate.upsert({
      where: { shop_productId_position_locale: { shop: session.shop, productId, position, locale } },
      create: { shop: session.shop, productId, position, positionLabel: positionLabel ?? null, locale, template },
      update: { positionLabel: positionLabel ?? null, template },
    });

    return json({ success: true, id: row.id });
  }

  return json({ success: false, error: "Method not allowed" }, { status: 405 });
};
