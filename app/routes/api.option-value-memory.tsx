import { json, type LoaderFunctionArgs, type ActionFunctionArgs } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { canAccessVariantImageManagerInEnv, isProductionLocked, type Plan } from "../utils/planUtils";

/**
 * Plan gate: the SKU / option-value memory powers the Pro+ SKU & key generator
 * (variantImageManager flag). Loader can return the empty map for any plan, but
 * the action must refuse writes from Free/Basic so a direct POST can't seed
 * data that would be hidden from the merchant's own UI.
 */
async function canMutate(shop: string): Promise<boolean> {
  const settings = await db.aISettings.findUnique({
    where: { shop },
    select: { subscriptionPlan: true },
  });
  const plan = (settings?.subscriptionPlan || "free") as Plan;
  return canAccessVariantImageManagerInEnv(plan, !isProductionLocked());
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const entries = await db.optionValueMemory.findMany({
    where: { shop },
    select: { optionValue: true, savedAs: true },
  });

  const memory = Object.fromEntries(entries.map(e => [e.optionValue, e.savedAs]));
  return json({ memory });
};

interface UpdateBody {
  intent: "update";
  optionValue: string;
  savedAs: string;
}

interface DeleteBody {
  intent: "delete";
  optionValue: string;
}

type Body = UpdateBody | DeleteBody;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  if (!(await canMutate(shop))) {
    return json({ ok: false, error: "SKU generator requires the Pro plan" }, { status: 403 });
  }
  const body = (await request.json()) as Body;

  if (body.intent === "delete") {
    await db.optionValueMemory.deleteMany({
      where: { shop, optionValue: body.optionValue },
    });
    return json({ ok: true });
  }

  if (body.intent === "update") {
    const trimmed = body.savedAs.trim();
    if (!trimmed) {
      return json({ ok: false, error: "Match key must not be empty" }, { status: 400 });
    }
    // Match keys are used in SKUs and image filenames — enforce ASCII-safe form.
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) {
      return json(
        { ok: false, error: "Match key must contain only letters, numbers, dot, underscore, hyphen" },
        { status: 400 },
      );
    }
    await db.optionValueMemory.upsert({
      where: { shop_optionValue: { shop, optionValue: body.optionValue } },
      update: { savedAs: trimmed },
      create: { shop, optionValue: body.optionValue, savedAs: trimmed },
    });
    return json({ ok: true });
  }

  return json({ ok: false, error: "Unknown intent" }, { status: 400 });
};
