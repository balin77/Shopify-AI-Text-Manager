/**
 * PLAN_CONTENT_CREATION §1.5 — `createContent`.
 *
 * A CASE in the existing `handleUnifiedContentActions` switch, never a parallel
 * route: products, collections, pages, blogs and articles all reach Shopify
 * through that one handler, and a second write path is exactly what the
 * architecture invariant in CLAUDE.md forbids.
 *
 * The shape of every create here is the same five steps, and each exists
 * because skipping it produces a specific, documented failure:
 *
 *   1. BOTH plan gates, server-side. `canAccessContentType` ("your plan does
 *      not include this content type") and the quantity limit ("limit
 *      reached") are different refusals with different remedies, and the UI
 *      lock is cosmetic — this action takes a POST.
 *   2. Validate against `create-fields.config.ts`. Never the client's claim
 *      about which fields exist, the same rule the bulk editor applies to
 *      columns.
 *   3. The mutation, per type.
 *   4. THE ECHO. `userErrors: []` is not success; the response has to carry an
 *      id AND the core fields back. For page/article/blog that includes the
 *      SEO metafields from the second `metafieldsSet` step — without which the
 *      form accepts SEO input and Shopify silently stores none of it (§1.3).
 *   5. Sync the new GID into the cache, assign the keyword, hand the id back.
 *
 * What this handler deliberately does NOT do is translate (§2.5a). Translation
 * stays the client's follow-up call to the EXISTING `translateAll` action, so
 * there is one translation write path and one progress UI, not two.
 */

import { data as json } from "react-router";
import type { ContentActionHandlerContext } from "./alt-text.action";
import { logger } from "~/utils/logger.server";
import { getFormString } from "~/utils/form-data.utils";
import {
  CREATE_ARTICLE,
  CREATE_BLOG,
  CREATE_COLLECTION,
  CREATE_METAOBJECT,
  CREATE_PAGE,
  CREATE_PRODUCT_SET,
  METAFIELDS_SET,
} from "~/graphql/content.mutations";
import {
  createSpecFor,
  metaobjectCreatability,
  metaobjectFieldDefs,
  metaobjectFieldsPayload,
  validateCreatePayload,
  type CreatableResource,
  type CreateFieldDef,
  type MetaobjectFieldDefinition,
} from "~/config/create-fields.config";
import { canAccessContentType, getMaxForResource, isAtLimit, type Plan } from "~/utils/planUtils";
import type { ContentType } from "~/types/content-editor.types";
import {
  RULES_MIN_API_VERSION,
  rulesAvailableOn,
  toSourcesInput,
  validateRuleSources,
  type RuleSource,
} from "~/config/collection-rules.shared";
import { resolveApiVersionString } from "~/utils/api-version";
import { CREATE_COLLECTION_WITH_SOURCES } from "~/graphql/content.mutations";
import {
  claimCreateRequest,
  previousCreateResult,
  recordCreateResult,
  releaseCreateRequest,
} from "~/utils/create-idempotency.server";

/** Shopify caps `metafieldsSet` at 25 per call; we send at most 2. */
const SEO_METAFIELD_NAMESPACE = "global";

interface CreateOutcome {
  id: string;
  /** What Shopify ACTUALLY assigned — on a collision it appends `-1` (§1.7). */
  handle?: string | null;
  title?: string | null;
  /** Extra info the client shows in the post-create box. */
  notes: string[];
}

/** Everything the per-type builders need, without re-deriving it five times. */
interface CreateInput {
  values: Record<string, string>;
  /** Staged upload URL from the picker, or "" — see §1.4 on the ONE upload path. */
  imageUrl: string;
  imageAlt: string;
}

function str(input: CreateInput, key: string): string {
  return (input.values[key] ?? "").trim();
}

function optional(input: CreateInput, key: string): string | undefined {
  const value = str(input, key);
  return value.length > 0 ? value : undefined;
}

function tagList(input: CreateInput, key: string): string[] | undefined {
  const raw = str(input, key);
  if (!raw) return undefined;
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}

/** Shopify money is a decimal STRING; a comma-decimal input is a real merchant
 *  habit and would otherwise be rejected as malformed. */
function money(input: CreateInput, key: string): string | undefined {
  const raw = str(input, key);
  return raw ? raw.replace(",", ".") : undefined;
}

type GraphQLResponse = { data?: any; errors?: Array<{ message: string }> };

/** userErrors from any of the create payloads, normalised to one line. */
function userErrorText(errors: Array<{ field?: string[] | null; message: string }> | undefined): string {
  if (!errors?.length) return "";
  return errors.map((e) => `${e.field?.join(".") ?? ""}: ${e.message}`.trim()).join("; ");
}

export async function handleCreateContent(ctx: ContentActionHandlerContext, formData: FormData) {
  const { admin, session, db } = ctx;

  const resource = getFormString(formData, "resource") as CreatableResource | "";
  const spec = resource ? createSpecFor(resource) : null;
  if (!spec) {
    return json({ success: false, error: `Unknown creatable resource: ${resource || "(missing)"}` }, { status: 400 });
  }

  const requestId = getFormString(formData, "requestId") || "";

  // Once Shopify has created the object, NOTHING downstream may turn this into
  // a failure: the merchant would retry and get a duplicate they cannot delete
  // from this app (§0.1). This holds the id from the moment it exists so the
  // catch below can tell "nothing happened" from "it exists, a later step
  // stumbled".
  let createdSoFar: CreateOutcome | null = null;

  // ── Idempotency (§1.7) ──────────────────────────────────────────────────
  // The FINISHED-first check comes before the plan gates on purpose: on a
  // retry the object from the first attempt is already counted, so running the
  // quantity gate first would answer "limit reached" instead of handing back
  // the result the merchant is actually waiting for.
  //
  // The CLAIM, by contrast, is taken late — just before the mutation. Claiming
  // up here would leave a claim behind on every validation failure, and the
  // corrected retry (same request id, as it must be for any of this to work)
  // would then be told "already in progress" forever.
  const finished = previousCreateResult(session.shop, requestId);
  if (finished) {
    logger.info("[CreateContent] Duplicate request, returning the first result", {
      context: "CreateContent",
      shop: session.shop,
      requestId,
    });
    return json(finished as Record<string, unknown>);
  }

  try {
    // ── 1. Plan gates — BOTH, and they are different refusals ─────────────
    const plan = (ctx.aiSettings?.subscriptionPlan || "free") as Plan;

    if (!canAccessContentType(plan, spec.planContentType as ContentType)) {
      return json(
        {
          success: false,
          errorCode: "planContentType",
          contentType: spec.planContentType,
          error: `Your plan does not include ${spec.planContentType}.`,
        },
        { status: 403 },
      );
    }

    if (spec.limitResource) {
      const current = await countExisting(db, session.shop, spec.limitResource);
      if (isAtLimit(plan, spec.limitResource, current)) {
        return json(
          {
            success: false,
            errorCode: "planLimit",
            limitResource: spec.limitResource,
            max: getMaxForResource(plan, spec.limitResource),
            current,
            error: `Plan limit reached for ${spec.limitResource}.`,
          },
          { status: 403 },
        );
      }
    }

    // ── 2. Validate against the shared spec ───────────────────────────────
    const values = collectValues(formData);
    const input: CreateInput = {
      values,
      imageUrl: getFormString(formData, "imageUrl") || "",
      imageAlt: getFormString(formData, "imageAlt") || "",
    };

    // §1.4b — the rule tree for an automated collection. Validated against the
    // SHARED spec, exactly like the field payload: the client's claim about
    // which condition kinds and relations exist is never taken at face value,
    // and the asymmetry between inclusion and exclusion is enforced here too.
    let ruleSources: RuleSource[] = [];
    if (resource === "collection") {
      const raw = getFormString(formData, "ruleSources") || "";
      if (raw) {
        if (!rulesAvailableOn(resolveApiVersionString())) {
          // The UI hides the editor below 2026-07; a direct POST must be
          // refused rather than silently dropped, or the merchant would be
          // told a rule was saved that was never sent.
          return json(
            {
              success: false,
              errorCode: "rulesUnavailable",
              error: `Collection rules need Shopify API ${RULES_MIN_API_VERSION}; this app is on ${resolveApiVersionString()}.`,
            },
            { status: 400 },
          );
        }
        try {
          ruleSources = JSON.parse(raw) as RuleSource[];
        } catch {
          return json({ success: false, errorCode: "validation", error: "Malformed rule payload." }, { status: 400 });
        }
        const ruleErrors = validateRuleSources(ruleSources);
        if (ruleErrors.length > 0) {
          return json({ success: false, errorCode: "ruleValidation", ruleErrors, error: "Invalid collection rules." }, { status: 400 });
        }
      }
    }

    // Metaobjects carry the definition's own fields, which only exist at
    // runtime — the validator has to be told about them or it would reject
    // every one of them as an unknown field.
    let extraFields: CreateFieldDef[] = [];
    let metaobjectDefinition: { type: string; fieldDefinitions: MetaobjectFieldDefinition[] } | null = null;
    if (resource === "metaobject") {
      const type = str(input, "type");
      const row = await db.metaobjectDefinition.findFirst({ where: { shop: session.shop, type } });
      if (!row) {
        return json({ success: false, error: `Unknown metaobject definition: ${type}` }, { status: 400 });
      }
      const fieldDefinitions = (row.fieldDefinitions as unknown as MetaobjectFieldDefinition[]) ?? [];
      const creatable = metaobjectCreatability(fieldDefinitions);
      if (!creatable.creatable) {
        // Re-checked here and not only in the UI: the reasons are real
        // (an unknown `required` would produce a guaranteed rejection).
        return json(
          { success: false, errorCode: creatable.reason, detail: creatable.detail, error: `Cannot create entries for "${type}".` },
          { status: 400 },
        );
      }
      metaobjectDefinition = { type: row.type, fieldDefinitions };
      extraFields = metaobjectFieldDefs(fieldDefinitions);
    }

    const errors = validateCreatePayload(resource as CreatableResource, values, extraFields);
    if (errors.length > 0) {
      return json({ success: false, errorCode: "validation", fieldErrors: errors, error: "Invalid payload." }, { status: 400 });
    }

    // Everything that could reject this request has now run. Claim the id so a
    // second POST while this one is in flight waits instead of creating again.
    if (!claimCreateRequest(session.shop, requestId)) {
      return json({
        actionType: "createContent",
        success: true,
        pending: true,
        message: "This create is already in progress.",
      });
    }

    // ── 3./4. Mutation + echo ─────────────────────────────────────────────
    const graphql = (query: string, variables: Record<string, unknown>) =>
      admin.graphql(query, { variables }).then((r) => r.json() as Promise<GraphQLResponse>);

    let outcome: CreateOutcome;
    switch (resource) {
      case "product":     outcome = await createProduct(graphql, input); break;
      case "collection":  outcome = await createCollection(graphql, input, ruleSources); break;
      case "page":        outcome = await createPage(graphql, input); break;
      case "article":     outcome = await createArticle(graphql, input); break;
      case "blog":        outcome = await createBlog(graphql, input); break;
      case "metaobject":  outcome = await createMetaobject(graphql, input, metaobjectDefinition!, extraFields); break;
      default:
        return json({ success: false, error: `Unhandled resource: ${resource}` }, { status: 400 });
    }

    createdSoFar = outcome;

    // SEO for page/article/blog is a SECOND step — the create input has no
    // `seo` field at all and the values would otherwise vanish silently.
    // Wrapped: the resource already exists, so a transport failure here is a
    // NOTE on a successful create, never a failed one.
    if (spec.seoViaMetafields) {
      try {
        const seoNote = await writeSeoMetafields(graphql, outcome.id, str(input, "seoTitle"), str(input, "metaDescription"));
        if (seoNote) outcome.notes.push(seoNote);
      } catch (seoError) {
        const message = seoError instanceof Error ? seoError.message : String(seoError);
        logger.warn("[CreateContent] SEO metafield step failed", { context: "CreateContent", id: outcome.id, error: message });
        outcome.notes.push("SEO fields could not be stored — please set them on the item.");
      }
    }

    // ── 5. Cache, keyword, response ───────────────────────────────────────
    // A failed sync is NOT a failed create (§1.6). The object exists in
    // Shopify; reporting an error here invites a second click and thus a
    // duplicate — the one mistake this whole flow is built to avoid.
    let synced = true;
    try {
      await syncNewResource(ctx, resource as CreatableResource, outcome.id, metaobjectDefinition?.type);
    } catch (error) {
      synced = false;
      logger.warn("[CreateContent] Created on Shopify but the cache sync failed", {
        context: "CreateContent",
        shop: session.shop,
        resource,
        id: outcome.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const keyword = str(input, "keyword");
    if (keyword) {
      try {
        await assignPrimaryKeyword(db, session.shop, resource as CreatableResource, outcome.id, keyword);
      } catch (error) {
        // Same reasoning as the sync: a keyword that did not stick is a note,
        // not a reason to tell the merchant their product was not created.
        outcome.notes.push("The keyword could not be assigned — you can set it in the SEO sidebar.");
        logger.warn("[CreateContent] assignKeyword failed", {
          context: "CreateContent",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const result = {
      actionType: "createContent" as const,
      success: true as const,
      resource,
      id: outcome.id,
      handle: outcome.handle ?? null,
      title: outcome.title ?? null,
      synced,
      notes: outcome.notes,
    };
    recordCreateResult(session.shop, requestId, result);

    logger.info("[CreateContent] Created", {
      context: "CreateContent",
      shop: session.shop,
      resource,
      id: outcome.id,
      synced,
    });

    return json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (createdSoFar) {
      // The object EXISTS. Reporting a failure here — and releasing the claim
      // with it — is precisely the "retry produces a duplicate" outcome this
      // whole flow is built to prevent. Report success with the problem as a
      // note, keep the claim, and let the merchant reload.
      logger.error("[CreateContent] Created, but a later step failed", {
        context: "CreateContent", shop: session.shop, resource, id: createdSoFar.id, error: message,
      });
      const salvaged = {
        actionType: "createContent" as const,
        success: true as const,
        resource,
        id: createdSoFar.id,
        handle: createdSoFar.handle ?? null,
        title: createdSoFar.title ?? null,
        synced: false,
        notes: [...createdSoFar.notes, "The item was created, but finishing up failed. Reload to see it — do not create it again."],
      };
      recordCreateResult(session.shop, requestId, salvaged);
      return json(salvaged);
    }

    // Nothing was created: release the claim so the merchant can genuinely
    // retry — a failed create that stays claimed would answer every retry
    // with "already in progress".
    releaseCreateRequest(session.shop, requestId);
    logger.error("[CreateContent] Failed", { context: "CreateContent", shop: session.shop, resource, error: message });
    return json({ success: false, error: message }, { status: 500 });
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Per-type creates. Each one ENDS with the echo check, never with userErrors.
// ────────────────────────────────────────────────────────────────────────────

function assertEcho(condition: unknown, what: string, detail: string): asserts condition {
  if (!condition) throw new Error(`${what} was not confirmed by Shopify${detail ? `: ${detail}` : ""}`);
}

/** Shopify normalises and truncates titles. Worth saying, not worth failing. */
function titleDriftNote(sent: string, got: string): string {
  return `Shopify stored the title as “${got}” instead of “${sent}”.`;
}

async function createProduct(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
): Promise<CreateOutcome> {
  const title = str(input, "title");
  const price = money(input, "price");
  const sku = optional(input, "sku");
  const barcode = optional(input, "barcode");
  const compareAt = money(input, "compareAtPrice");

  const productInput: Record<string, unknown> = {
    title,
    // §2.3 — DRAFT unless the merchant deliberately chose otherwise, so
    // nothing goes live by accident. Note that ACTIVE alone does NOT make a
    // product visible; that needs a publication, which is Phase 4.
    status: optional(input, "status") ?? "DRAFT",
    descriptionHtml: optional(input, "descriptionHtml"),
    handle: optional(input, "handle"),
    productType: optional(input, "productType"),
    vendor: optional(input, "vendor"),
    tags: tagList(input, "tags"),
    seo: seoInput(input),
  };

  // ONE upload path (§1.4): the staged URL goes straight into the create as
  // `originalSource`. Calling fileCreate first and passing media here as well
  // produces TWO MediaImages for one file and collides with the media-library
  // cache's no-double-listing rule.
  if (input.imageUrl) {
    productInput.files = [
      {
        originalSource: input.imageUrl,
        contentType: "IMAGE",
        alt: input.imageAlt || undefined,
      },
    ];
  }

  // The default variant carries the price — §2.2, and it needs no extra scope.
  if (price || compareAt || sku || barcode) {
    productInput.variants = [
      {
        price,
        compareAtPrice: compareAt,
        barcode,
        ...(sku ? { inventoryItem: { sku } } : {}),
        optionValues: [{ optionName: "Title", name: "Default Title" }],
      },
    ];
    productInput.productOptions = [{ name: "Title", values: [{ name: "Default Title" }] }];
  }

  const response = await graphql(CREATE_PRODUCT_SET, {
    input: stripUndefined(productInput),
    // Synchronous: the client selects the new item immediately afterwards, so
    // an id that is not yet queryable would surface as "created but missing".
    synchronous: true,
  });

  const payload = response.data?.productSet;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const product = payload?.product;

  // Only the MISSING ID is a failure: at that point nothing was created and a
  // retry is safe. A title that came back different (Shopify normalises and
  // truncates) is a NOTE — throwing there would take the "nothing was
  // created" branch on an object that very much exists, release the
  // idempotency claim, and hand the merchant a duplicate on their retry.
  assertEcho(product?.id, "Product create", errorText);

  const notes: string[] = [];
  if (product.title !== title) notes.push(titleDriftNote(title, product.title));
  const variant = product.variants?.nodes?.[0];
  if (price && (!variant || variant.price == null)) {
    // Explicit rather than silent: the product exists but is not sellable.
    notes.push("The price was not stored — please set it on the product.");
  }
  if (input.imageUrl) notes.push("The image is being processed by Shopify and may take a moment to appear.");

  return { id: product.id, handle: product.handle, title: product.title, notes };
}

async function createCollection(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
  ruleSources: RuleSource[],
): Promise<CreateOutcome> {
  const title = str(input, "title");

  // `collectionCreate(input: CollectionInput)` on purpose, NOT the 2026-07
  // `collection: CollectionCreateInput`. This path has to work on the version
  // the app is pinned to TODAY, and every field it sets exists on both. The
  // rule editor (§1.4b) is what needs `sources` and therefore 2026-07; a
  // manual collection does not, so creation is not held hostage to Phase −1.
  const collectionInput: Record<string, unknown> = {
    title,
    descriptionHtml: optional(input, "descriptionHtml"),
    handle: optional(input, "handle"),
    sortOrder: optional(input, "sortOrder"),
    seo: seoInput(input),
  };
  if (input.imageUrl) {
    collectionInput.image = { src: input.imageUrl, altText: input.imageAlt || undefined };
  }

  // TWO shapes on purpose. A MANUAL collection goes through the deprecated
  // `input: CollectionInput`, which exists on every version this app can be
  // pinned to — so creating one is not held hostage to the API move. A
  // RULE-BASED one needs `collection: CollectionCreateInput` with `sources[]`,
  // which only exists from 2026-07; the caller has already refused the request
  // if that is not reachable.
  const hasRules = ruleSources.some((s) => !s.unrenderable);
  const response = hasRules
    ? await graphql(CREATE_COLLECTION_WITH_SOURCES, {
        collection: stripUndefined({ ...collectionInput, sources: toSourcesInput(ruleSources) }),
      })
    : await graphql(CREATE_COLLECTION, { input: stripUndefined(collectionInput) });
  const payload = response.data?.collectionCreate;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const collection = payload?.collection;

  // See createProduct: a missing id is a failure, a drifted title is a note.
  assertEcho(collection?.id, "Collection create", errorText);
  const titleNote = collection.title !== title ? [titleDriftNote(title, collection.title)] : [];

  return { id: collection.id, handle: collection.handle, title: collection.title, notes: titleNote };
}

async function createPage(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
): Promise<CreateOutcome> {
  const title = str(input, "title");
  const pageInput = stripUndefined({
    title,
    body: optional(input, "body"),
    handle: optional(input, "handle"),
    // Unpublished by default, same reasoning as a DRAFT product (§2.3).
    isPublished: false,
  });

  const response = await graphql(CREATE_PAGE, { page: pageInput });
  const payload = response.data?.pageCreate;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const page = payload?.page;

  // See createProduct: a missing id is a failure, a drifted title is a note.
  assertEcho(page?.id, "Page create", errorText);
  const titleNote = page.title !== title ? [titleDriftNote(title, page.title)] : [];

  return {
    id: page.id,
    handle: page.handle,
    title: page.title,
    notes: [...titleNote, "The page is not published yet — publish it once the content is ready."],
  };
}

async function createArticle(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
): Promise<CreateOutcome> {
  const title = str(input, "title");
  const articleInput: Record<string, unknown> = {
    blogId: str(input, "blogId"),
    title,
    // Mandatory on ArticleCreateInput and nowhere else in this app (§1.4).
    author: { name: str(input, "author") },
    body: optional(input, "body"),
    summary: optional(input, "summary"),
    handle: optional(input, "handle"),
    tags: tagList(input, "tags"),
    isPublished: false,
  };
  if (input.imageUrl) {
    articleInput.image = { url: input.imageUrl, altText: input.imageAlt || undefined };
  }

  const response = await graphql(CREATE_ARTICLE, { article: stripUndefined(articleInput) });
  const payload = response.data?.articleCreate;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const article = payload?.article;

  // See createProduct: a missing id is a failure, a drifted title is a note.
  assertEcho(article?.id, "Article create", errorText);
  const titleNote = article.title !== title ? [titleDriftNote(title, article.title)] : [];

  return {
    id: article.id,
    handle: article.handle,
    title: article.title,
    notes: [...titleNote, "The article is not published yet — publish it once the content is ready."],
  };
}

async function createBlog(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
): Promise<CreateOutcome> {
  const title = str(input, "title");
  const blogInput = stripUndefined({
    title,
    handle: optional(input, "handle"),
    commentPolicy: optional(input, "commentPolicy"),
  });

  const response = await graphql(CREATE_BLOG, { blog: blogInput });
  const payload = response.data?.blogCreate;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const blog = payload?.blog;

  // See createProduct: a missing id is a failure, a drifted title is a note.
  assertEcho(blog?.id, "Blog create", errorText);
  const titleNote = blog.title !== title ? [titleDriftNote(title, blog.title)] : [];

  return { id: blog.id, handle: blog.handle, title: blog.title, notes: titleNote };
}

async function createMetaobject(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  input: CreateInput,
  definition: { type: string; fieldDefinitions: MetaobjectFieldDefinition[] },
  extraFields: CreateFieldDef[],
): Promise<CreateOutcome> {
  // The definition's fields arrive prefixed so they cannot collide with the
  // spec's own keys (`handle`, `type`).
  // Built by the shared config so the shape is covered by a test —
  // MetaobjectFieldInput takes exactly `key` and `value`, and an extra
  // property makes GraphQL refuse the whole variable.
  const fields = metaobjectFieldsPayload(extraFields, input.values);

  const response = await graphql(CREATE_METAOBJECT, {
    metaobject: stripUndefined({
      type: definition.type,
      handle: optional(input, "handle"),
      fields,
    }),
  });

  const payload = response.data?.metaobjectCreate;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";
  const metaobject = payload?.metaobject;

  assertEcho(metaobject?.id, "Metaobject create", errorText);

  // Echo on the VALUES, not just the id: a field Shopify dropped would
  // otherwise show up as an empty entry the merchant has to re-fill.
  const echoed = new Map<string, string>((metaobject.fields ?? []).map((f: any) => [f.key, f.value ?? ""]));
  const missing = fields.filter((f) => (echoed.get(f.key) ?? "") !== f.value).map((f) => f.key);
  const notes = missing.length > 0 ? [`Not stored by Shopify: ${missing.join(", ")}`] : [];

  return { id: metaobject.id, handle: metaobject.handle, title: metaobject.displayName, notes };
}

// ────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ────────────────────────────────────────────────────────────────────────────

function seoInput(input: CreateInput): { title?: string; description?: string } | undefined {
  const title = optional(input, "seoTitle");
  const description = optional(input, "metaDescription");
  if (!title && !description) return undefined;
  return stripUndefined({ title, description });
}

/**
 * The SECOND step for page/article/blog (§1.3): their meta title/description
 * live in `global.title_tag` / `description_tag`, not in a `seo` field.
 *
 * `metafieldsSet` rejects `""` ("Value can't be blank") and needs an explicit
 * `type` when creating without a definition — both are documented gotchas, and
 * both are why empty values are simply not sent rather than sent as blanks.
 *
 * Returns a NOTE when Shopify did not echo the values back, instead of
 * throwing: the resource itself exists at that point, and failing the whole
 * create would leave an object behind that the merchant is then told was not
 * created.
 */
async function writeSeoMetafields(
  graphql: (q: string, v: Record<string, unknown>) => Promise<GraphQLResponse>,
  ownerId: string,
  seoTitle: string,
  metaDescription: string,
): Promise<string | null> {
  const metafields: Array<Record<string, string>> = [];
  if (seoTitle) {
    metafields.push({ ownerId, namespace: SEO_METAFIELD_NAMESPACE, key: "title_tag", type: "single_line_text_field", value: seoTitle });
  }
  if (metaDescription) {
    metafields.push({ ownerId, namespace: SEO_METAFIELD_NAMESPACE, key: "description_tag", type: "multi_line_text_field", value: metaDescription });
  }
  if (metafields.length === 0) return null;

  const response = await graphql(METAFIELDS_SET, { metafields });
  const payload = response.data?.metafieldsSet;
  const errorText = userErrorText(payload?.userErrors) || response.errors?.map((e) => e.message).join("; ") || "";

  const echoed = new Map<string, string>((payload?.metafields ?? []).map((m: any) => [m.key, m.value ?? ""]));
  const failed = metafields.filter((m) => echoed.get(m.key) !== m.value).map((m) => m.key);
  if (failed.length === 0) return null;

  logger.warn("[CreateContent] SEO metafields not echoed back", { context: "CreateContent", ownerId, failed, errorText });
  return `SEO fields were not stored (${failed.join(", ")}) — please set them on the item.${errorText ? ` ${errorText}` : ""}`;
}

/** Drop undefined keys so a partial input never sends explicit nulls. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/** `field.*` values arrive as their own form keys; everything is a string. */
function collectValues(formData: FormData): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (typeof value !== "string") continue;
    if (key.startsWith("value.")) values[key.slice("value.".length)] = value;
  }
  return values;
}

async function countExisting(
  db: ContentActionHandlerContext["db"],
  shop: string,
  limitResource: "products" | "collections" | "articles" | "pages",
): Promise<number> {
  switch (limitResource) {
    case "products":    return db.product.count({ where: { shop } });
    case "collections": return db.collection.count({ where: { shop } });
    case "articles":    return db.article.count({ where: { shop } });
    case "pages":       return db.page.count({ where: { shop } });
  }
}

/**
 * Pull the brand-new GID into the cache.
 *
 * Phase-0 measurement: every `syncSingleX` has a `create` branch, so a GID the
 * cache has never seen IS written rather than skipped. (CLAUDE.md's "reload
 * only refreshes known IDs" is about the LIST not discovering new resources —
 * a targeted reload on a known-new id works, and that is what this is.)
 */
async function syncNewResource(
  ctx: ContentActionHandlerContext,
  resource: CreatableResource,
  gid: string,
  metaobjectType?: string,
): Promise<void> {
  const { admin, session } = ctx;
  const numericId = gid.split("/").pop()!;

  switch (resource) {
    case "product": {
      const { ProductSyncService } = await import("~/services/product-sync.service");
      const { getPlanLimits } = await import("~/utils/planUtils");
      const plan = (ctx.aiSettings?.subscriptionPlan || "free") as Plan;
      await new ProductSyncService(admin, session.shop).syncSingleProduct(
        numericId,
        getPlanLimits(plan).cacheEnabled.productImages,
      );
      return;
    }
    case "collection": {
      const { ContentSyncService } = await import("~/services/content-sync.service");
      await new ContentSyncService(admin, session.shop).syncSingleCollection(numericId);
      return;
    }
    case "article": {
      const { ContentSyncService } = await import("~/services/content-sync.service");
      await new ContentSyncService(admin, session.shop).syncSingleArticle(numericId);
      return;
    }
    case "blog": {
      const { ContentSyncService } = await import("~/services/content-sync.service");
      await new ContentSyncService(admin, session.shop).syncSingleBlog(numericId);
      return;
    }
    case "page": {
      const { BackgroundSyncService } = await import("~/services/background-sync.service");
      await new BackgroundSyncService(admin, session.shop).syncSinglePage(gid);
      return;
    }
    case "metaobject": {
      // Metaobjects sync per TYPE, which re-fetches the whole type and so
      // picks the new entry up along the way.
      const { MetaobjectSyncService } = await import("~/services/metaobject-sync.service");
      await new MetaobjectSyncService(admin, session.shop).syncMetaobjectsForType(metaobjectType!);
      return;
    }
  }
}

/**
 * §2.5d — the moment the merchant decides what an item is ABOUT is the best
 * moment for its keyword, and it is exactly the moment the AI is otherwise
 * keyword-blind (`loadTrackedKeywords` keys off a resourceId a new item does
 * not have yet). The modal therefore passes the keyword into the prompt AND
 * assigns it here.
 *
 * Blogs and metaobjects have no keyword concept in this app's model, so they
 * are skipped rather than forced into one.
 */
async function assignPrimaryKeyword(
  db: ContentActionHandlerContext["db"],
  shop: string,
  resource: CreatableResource,
  gid: string,
  keyword: string,
): Promise<void> {
  const map: Partial<Record<CreatableResource, "Product" | "Collection" | "Article" | "Page">> = {
    product: "Product",
    collection: "Collection",
    article: "Article",
    page: "Page",
  };
  const resourceType = map[resource];
  if (!resourceType) return;

  const { assignKeyword } = await import("~/services/seo/keywords.service");
  await assignKeyword(db, shop, { resourceType, resourceId: gid, keyword, role: "primary" });
}
