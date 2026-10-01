/**
 * PLAN_CONTENT_CREATION §1.3/§1.5 — the option lists the create form cannot
 * know statically.
 *
 * Two of the six creatable types need a choice that depends on the shop:
 *
 *   - an ARTICLE must name the blog it lives in (`blogId` is mandatory), and a
 *     shop with no blog at all cannot have one — §1.7 says point that out and
 *     offer the blog form instead of failing at submit
 *   - a METAOBJECT entry must name its definition, and only definitions whose
 *     REQUIRED fields are all plain text can be offered (§1.5): the app has
 *     editors for three field types, so anything else would present a form
 *     that Shopify is guaranteed to reject
 *
 * A read-only helper, deliberately NOT a second write path — creating still
 * goes through the one `createContent` case in the unified handler.
 *
 * Every refused option is returned WITH ITS REASON rather than filtered out.
 * A definition that silently vanishes from the list looks like a bug; one that
 * says "this type has a required field we cannot fill in" is an explanation.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";
import { LIST_BLOGS_FOR_CREATE } from "~/graphql/content.mutations";
import {
  metaobjectCreatability,
  metaobjectFieldDefs,
  type CreateFieldDef,
  type MetaobjectFieldDefinition,
} from "~/config/create-fields.config";

export interface CreateOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Why it is disabled — shown, never swallowed. Prefer the CODE below;
   *  this stays for options whose reason is not a fixed sentence. */
  helpText?: string;
  /** An i18n key under `t.content`, phrased by the client. */
  helpTextCode?: string;
  /** Interpolated into `{detail}` of that sentence. */
  helpTextDetail?: string;
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const resource = url.searchParams.get("resource") || "";

  try {
    if (resource === "article") {
      const response = await admin.graphql(LIST_BLOGS_FOR_CREATE, { variables: { first: 100 } });
      const data = (await response.json()) as { data?: { blogs?: { nodes?: Array<{ id: string; title: string }> } } };
      const blogs = data.data?.blogs?.nodes ?? [];
      return json({
        success: true,
        options: { blogId: blogs.map((b) => ({ value: b.id, label: b.title })) satisfies CreateOption[] },
        extraFieldsByOption: {},
        // §1.7 — the shop has no blog yet. The UI turns this into "create a
        // blog first", which is actionable; a failed submit is not.
        needsBlogFirst: blogs.length === 0,
      });
    }

    if (resource === "metaobject") {
      const definitions = await db.metaobjectDefinition.findMany({
        where: { shop: session.shop },
        orderBy: { name: "asc" },
      });

      const options: CreateOption[] = [];
      const extraFieldsByOption: Record<string, CreateFieldDef[]> = {};

      for (const def of definitions) {
        const fieldDefinitions = (def.fieldDefinitions as unknown as MetaobjectFieldDefinition[]) ?? [];
        const creatable = metaobjectCreatability(fieldDefinitions);
        if (creatable.creatable) {
          options.push({ value: def.type, label: def.name || def.type });
          extraFieldsByOption[def.type] = metaobjectFieldDefs(fieldDefinitions);
          continue;
        }
        // A CODE, not a sentence. The server has no idea which language the
        // merchant reads, and this text is what explains a greyed-out type --
        // it used to arrive in English on a German shop, at exactly the moment
        // something needed explaining. `requiredUnknown` = cached before the
        // Phase-0 sync, so we do not KNOW which fields are mandatory and
        // guessing "none" would produce a form Shopify rejects for a field
        // nobody was asked for.
        options.push({
          value: def.type,
          label: def.name || def.type,
          disabled: true,
          helpTextCode:
            creatable.reason === "requiredUnknown"
              ? "createTypeUnknownRequired"
              : "createTypeUnsupportedFields",
          helpTextDetail: creatable.detail,
        });
      }

      return json({ success: true, options: { type: options }, extraFieldsByOption, needsBlogFirst: false });
    }

    // Every other creatable type is fully described by create-fields.config.ts.
    return json({ success: true, options: {}, extraFieldsByOption: {}, needsBlogFirst: false });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("[CreateOptions] Failed", { context: "CreateOptions", resource, error: message });
    return json({ success: false, error: message, options: {}, extraFieldsByOption: {}, needsBlogFirst: false }, { status: 500 });
  }
}
