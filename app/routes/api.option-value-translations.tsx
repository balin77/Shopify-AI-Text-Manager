import { json, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import {
  fetchMetaobjectTranslationById,
  fetchOptionValueTranslationById,
} from "../utils/alt-text-template";

interface OptionLookup {
  optionValueGid: string;
  metaobjectGid?: string | null;
}

interface RequestBody {
  locale?: string;
  options?: OptionLookup[];
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  const { admin } = await authenticate.admin(request);
  const body = (await request.json()) as RequestBody;
  const locale = body.locale;
  const options = Array.isArray(body.options) ? body.options : [];

  if (!locale || options.length === 0) {
    return json({ translations: {} });
  }

  // Deduplicate by optionValueGid — the response key the client uses to look up.
  const byKey = new Map<string, OptionLookup>();
  for (const opt of options) {
    if (typeof opt?.optionValueGid !== "string" || opt.optionValueGid.length === 0) continue;
    if (!byKey.has(opt.optionValueGid)) byKey.set(opt.optionValueGid, opt);
  }

  const translations: Record<string, string> = {};

  await Promise.all(
    Array.from(byKey.values()).map(async (opt) => {
      // Same priority as resolveVariableValues: metaobject first, then ProductOptionValue.
      if (opt.metaobjectGid) {
        const value = await fetchMetaobjectTranslationById(opt.metaobjectGid, locale, admin);
        if (value) {
          translations[opt.optionValueGid] = value;
          return;
        }
      }
      const value = await fetchOptionValueTranslationById(opt.optionValueGid, locale, admin);
      if (value) translations[opt.optionValueGid] = value;
    })
  );

  return json({ translations });
};
