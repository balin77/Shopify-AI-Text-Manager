/**
 * The permitted taxonomy values for ONE field of ONE metaobject definition.
 *
 * Its own route because the list is only needed while a taxonomy control is on
 * screen: folding it into the entry loader would run the category sweep on
 * every page view of every type, including the ones that have no such field.
 *
 * It gates itself -- directly GET-reachable, same class as the entry loader
 * and the usage route.
 *
 * The attribute HANDLE is read SERVER-side out of the cached definition's
 * validations and never taken from the client: the client would then be able
 * to name any attribute it liked, and more to the point it does not have the
 * validations at all. The client names the definition TYPE and the FIELD KEY,
 * which are what it legitimately knows.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { canAccessContentType } from "~/utils/planUtils";
import type { Plan } from "~/config/plans";
import {
  definitionFieldType,
  isMetaobjectTaxonomyListType,
  metaobjectFieldRole,
  taxonomyAttributeHandle,
  taxonomyValueBounds,
  TAXONOMY_VALUE_GID_PATTERN,
  type MetaobjectDefinitionFieldLike,
} from "~/services/metaobject-fields.shared";
import { taxonomyValueNames, taxonomyValuesForHandle } from "~/services/taxonomy-values.server";

/** Enough for a whole entry's worth of stored references, and a bound on a
 *  list that arrives in a query string. */
const MAX_IDS = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");

  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!canAccessContentType((settings?.subscriptionPlan || "free") as Plan, "metaobjects")) {
    return json({ success: false, error: "Your plan does not include metaobjects." }, { status: 403 });
  }

  const url = new URL(request.url);
  /**
   * `values` (default) reads the permitted list; `names` resolves stored GIDs
   * only. Separate because the list costs a three-round category sweep and the
   * names cost one cheap `nodes(ids:)` -- a names request that also swept was
   * a throttling storm waiting for the exact case it fires in: the list came
   * back `attributeNotFound`, so EVERY control on the page has ids the list
   * cannot explain and asks for names.
   */
  const mode = url.searchParams.get("mode") === "names" ? "names" : "values";
  const type = (url.searchParams.get("type") || "").trim();
  const fieldKey = (url.searchParams.get("field") || "").trim();
  const ids = (url.searchParams.get("ids") || "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => TAXONOMY_VALUE_GID_PATTERN.test(s))
    .slice(0, MAX_IDS);

  if (!type || !fieldKey) {
    return json({ success: false, error: "type and field are required." }, { status: 400 });
  }

  const definition = await db.metaobjectDefinition.findUnique({
    where: { shop_type: { shop: session.shop, type } },
    select: { fieldDefinitions: true },
  });
  if (!definition) {
    return json({ success: false, error: "Unknown metaobject definition." }, { status: 404 });
  }

  const fields = (definition.fieldDefinitions ?? []) as unknown as MetaobjectDefinitionFieldLike[];
  const field = Array.isArray(fields) ? fields.find((f) => f?.key === fieldKey) : undefined;
  if (!field) {
    return json({ success: false, error: "Unknown field on this definition." }, { status: 404 });
  }

  const fieldType = definitionFieldType(field);
  if (metaobjectFieldRole(fieldType) !== "taxonomyValue") {
    return json({ success: false, error: "This field is not a taxonomy reference." }, { status: 400 });
  }

  const handle = taxonomyAttributeHandle(field.validations);
  const bounds = taxonomyValueBounds(fieldType, field.validations);

  // The two halves are independent on purpose: a stored value must still be
  // NAMEABLE when the attribute lookup fails, or the control would show a bare
  // GID next to a message about a list it could not read.
  const [values, names] = await Promise.all([
    mode === "names"
      ? Promise.resolve(undefined)
      : handle
        ? taxonomyValuesForHandle(admin, handle)
        : Promise.resolve({ known: false as const, reason: "attributeNotFound" as const }),
    taxonomyValueNames(admin, ids),
  ]);

  return json(
    {
      success: true,
      field: {
        key: fieldKey,
        type: fieldType,
        isList: isMetaobjectTaxonomyListType(fieldType),
        handle,
        min: bounds.min,
        max: bounds.max,
      },
      values,
      names,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
};
