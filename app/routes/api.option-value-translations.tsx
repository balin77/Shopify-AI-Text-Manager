import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { fetchMetaobjectTranslationById } from "../utils/alt-text-template";

interface RequestBody {
  locale?: string;
  gids?: string[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { admin } = await authenticate.admin(request);
  const body = (await request.json()) as RequestBody;
  const locale = body.locale;
  const gids = Array.isArray(body.gids) ? body.gids.filter((g) => typeof g === "string" && g.length > 0) : [];

  if (!locale || gids.length === 0) {
    return json({ translations: {} });
  }

  const uniqueGids = Array.from(new Set(gids));
  const translations: Record<string, string> = {};

  await Promise.all(
    uniqueGids.map(async (gid) => {
      const value = await fetchMetaobjectTranslationById(gid, locale, admin);
      if (value) translations[gid] = value;
    })
  );

  return json({ translations });
};
