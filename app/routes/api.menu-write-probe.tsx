/**
 * Menu WRITE probe — what does menuUpdate actually do to a menu?
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * /app/menus translates menu items and refuses to touch their PRIMARY titles.
 * That refusal was never a platform limit — the scope
 * (write_online_store_navigation) has been declared since the URL-redirect
 * feature — it was a refusal to write a mutation whose behaviour nobody here
 * had measured. `menuUpdate` takes the WHOLE item list, so "rename one item"
 * is in truth "write the merchant's entire navigation back from our cache".
 * Everything dangerous about the feature follows from that one shape, and
 * every fact it depends on is measurable in about four round trips:
 *
 *   1. IDS. Does a MenuItem keep its id across an update? This is the
 *      load-bearing one and it is not cosmetic: a menu item's translation
 *      lives on gid://shopify/Link/<same number> (measured 2026-08, see
 *      menu-translations.shared.ts). If Shopify mints new ids on update, a
 *      rename silently orphans every translation of that menu — and
 *      refreshMenuCache's orphan cleanup would then DELETE those rows on the
 *      very next page load. A feature that loses translations on rename is
 *      not shippable; a feature whose ids are stable is.
 *
 *   2. OMISSION. Is an item left out of the list actually deleted? The whole
 *      conservative design of the write path (re-read fresh, refuse on drift)
 *      is justified by the answer being yes. If it were no, the design would
 *      be needless ceremony — so it is measured rather than assumed.
 *
 *   3. RESOURCE BINDING. A menu item that points at a product carries a
 *      resourceId. Our cache query never selected it, so a naive write-back
 *      would turn a product link into nothing. This measures whether
 *      resourceId survives a round trip when it IS sent — i.e. whether
 *      reading it is sufficient.
 *
 *   4. TRANSLATION SURVIVAL. After a primary rename, is the item's existing
 *      translation still there, and does Shopify mark it outdated? That
 *      decides whether the app's own stale-translation policy has anything to
 *      react to, or whether Shopify already dropped the value.
 *
 *   5. SCHEMA. The exact fields of MenuItemCreateInput / MenuItemUpdateInput,
 *      read by introspection FROM THE SHOP. shopify.dev is not reachable from
 *      every environment this repo is developed in, and a hand-copied input
 *      shape is exactly how the collection-sources reader shipped dead (see
 *      CLAUDE.md): an unknown field is a SCHEMA-level error with data: null
 *      and no userErrors, so it fails everything at once and explains nothing.
 *
 * ── Why it builds its own menu ─────────────────────────────────────────────
 * Every measurement above is destructive by nature — the omission test
 * DELETES a menu item. Doing that to the merchant's navigation to learn how
 * deletion works is not a probe, it is an outage. So the probe creates its own
 * three-level menu under a stamped handle, measures on it, and deletes it in a
 * finally. A menu is only rendered by a theme that references its handle, so a
 * throwaway handle is invisible in the storefront for the seconds it lives.
 * If the delete ever fails, the report says so with the handle, loudly.
 *
 * Nothing here reads or writes the shop's real menus.
 */

import { data as json, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";
import { db } from "~/db.server";
import { meetsPlan } from "~/utils/planUtils";
import { resolveApiVersionString } from "~/utils/api-version";
import { linkGidForMenuItem } from "~/services/menu-translations.shared";

// ── Queries and mutations ──────────────────────────────────────────────────
// No prose and no non-ASCII inside a #graphql literal: the text between the
// backticks goes to Shopify verbatim, and a comment there has taken this app's
// blog page down once already (CLAUDE.md).

/**
 * The read selection every step shares. Four levels although Shopify documents
 * three — a query that reads exactly as deep as the docs promise cannot tell
 * "there is no fourth level" from "we did not look", and this probe's whole
 * subject is what happens to items nobody looked at.
 */
const MENU_ITEM_FIELDS = `
  id
  title
  type
  url
  resourceId
  tags
`;

const MENU_READ_QUERY = `#graphql
  query menuWriteProbeRead($id: ID!) {
    menu(id: $id) {
      id
      title
      handle
      items {
        ${MENU_ITEM_FIELDS}
        items {
          ${MENU_ITEM_FIELDS}
          items {
            ${MENU_ITEM_FIELDS}
            items {
              ${MENU_ITEM_FIELDS}
            }
          }
        }
      }
    }
  }
`;

const MENU_CREATE_MUTATION = `#graphql
  mutation menuWriteProbeCreate($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
    menuCreate(title: $title, handle: $handle, items: $items) {
      menu {
        id
        handle
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MENU_UPDATE_MUTATION = `#graphql
  mutation menuWriteProbeUpdate($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
    menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
      menu {
        id
        items {
          ${MENU_ITEM_FIELDS}
          items {
            ${MENU_ITEM_FIELDS}
            items {
              ${MENU_ITEM_FIELDS}
            }
          }
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const MENU_DELETE_MUTATION = `#graphql
  mutation menuWriteProbeDelete($id: ID!) {
    menuDelete(id: $id) {
      deletedMenuId
      userErrors {
        field
        message
      }
    }
  }
`;

const SAMPLE_RESOURCES_QUERY = `#graphql
  query menuWriteProbeSamples {
    products(first: 1) {
      nodes {
        id
        title
      }
    }
    collections(first: 1) {
      nodes {
        id
        title
      }
    }
  }
`;

const LOCALES_QUERY = `#graphql
  query menuWriteProbeLocales {
    shopLocales {
      locale
      primary
      published
    }
  }
`;

const LINK_TRANSLATABLE_QUERY = `#graphql
  query menuWriteProbeLink($id: ID!, $locale: String!) {
    translatableResource(resourceId: $id) {
      resourceId
      translatableContent {
        key
        value
        digest
      }
      translations(locale: $locale) {
        key
        value
        outdated
      }
    }
  }
`;

const REGISTER_MUTATION = `#graphql
  mutation menuWriteProbeRegister($resourceId: ID!, $translations: [TranslationInput!]!) {
    translationsRegister(resourceId: $resourceId, translations: $translations) {
      translations {
        key
        value
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * Introspection of the two input objects, run against the SHOP rather than
 * against shopify.dev: the schema proxy is unreachable from sandboxed
 * environments, and the shop's own schema is the one the app talks to anyway.
 */
const INPUT_INTROSPECTION_QUERY = `#graphql
  query menuWriteProbeSchema {
    createInput: __type(name: "MenuItemCreateInput") {
      name
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
    updateInput: __type(name: "MenuItemUpdateInput") {
      name
      inputFields {
        name
        type {
          kind
          name
          ofType {
            kind
            name
            ofType {
              kind
              name
            }
          }
        }
      }
    }
    itemType: __type(name: "MenuItemType") {
      name
      enumValues {
        name
      }
    }
  }
`;

// ── Report shape ───────────────────────────────────────────────────────────

interface ProbeItem {
  id: string;
  title: string;
  type: string | null;
  url: string | null;
  resourceId: string | null;
  tags: string[];
  depth: number;
  path: string;
}

interface SchemaField {
  name: string;
  type: string;
  required: boolean;
}

export interface MenuWriteProbeReport {
  generatedAt: string;
  shop: string;
  apiVersion: string;
  schema: {
    error?: string;
    createInput: SchemaField[];
    updateInput: SchemaField[];
    itemTypes: string[];
  };
  setup: {
    handle: string;
    menuId: string | null;
    boundResource: { type: string; id: string; title: string } | null;
    created: boolean;
    errors: string[];
  };
  baseline: {
    items: ProbeItem[];
    /** resourceId survived the CREATE round trip (null = nothing bound). */
    resourceIdStoredOnCreate: boolean | null;
  };
  rename: {
    attempted: boolean;
    targetItemId: string | null;
    targetPath: string | null;
    newTitle: string | null;
    echoedTitle: string | null;
    readBackTitle: string | null;
    idsStable: boolean | null;
    idChanges: Array<{ path: string; before: string; after: string }>;
    collateralTitleChanges: Array<{ path: string; before: string; after: string }>;
    resourceIdPreserved: boolean | null;
    itemCountBefore: number;
    itemCountAfter: number;
    errors: string[];
  };
  omission: {
    attempted: boolean;
    omittedItemId: string | null;
    omittedPath: string | null;
    stillPresentAfterwards: boolean | null;
    siblingsSurvived: boolean | null;
    errors: string[];
  };
  translation: {
    attempted: boolean;
    locale: string | null;
    linkId: string | null;
    /** The Link resource of a just-created menu item resolves at all. */
    linkResolved: boolean | null;
    registered: boolean | null;
    valueBeforeRename: string | null;
    valueAfterRename: string | null;
    outdatedAfterRename: boolean | null;
    digestChanged: boolean | null;
    errors: string[];
  };
  /**
   * Does a whole-tree write-back survive item types that are neither HTTP nor
   * resource-bound?
   *
   * The write path sends every field Shopify handed it, `url` included. A
   * default main menu's FRONTPAGE / SEARCH / CATALOG item comes back WITH a
   * url, and if the mutation refuses that pairing the single userError fails
   * the entire menuUpdate — no rename in that menu would ever land. Measured
   * in a SECOND throwaway menu so an item type this shop's schema does not
   * accept cannot block the measurements above.
   */
  typeRoundTrip: {
    attempted: boolean;
    menuId: string | null;
    typesTried: string[];
    createErrors: string[];
    /** What Shopify returned for each created item. */
    read: Array<{ type: string | null; title: string; url: string | null; resourceId: string | null }>;
    /** Write-back of the tree exactly as read — what the write path does. */
    asReadOk: boolean | null;
    asReadErrors: string[];
    /** Only attempted when the first one failed: same tree, url stripped off non-HTTP items. */
    withoutUrlOk: boolean | null;
    withoutUrlErrors: string[];
  };
  cleanup: {
    deleted: boolean;
    /** The second menu's own delete. Reported apart: two menus, two outcomes. */
    typesMenuDeleted: boolean | null;
    errors: string[];
  };
  verdict: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

type GqlResult = { data?: Record<string, unknown>; errors?: Array<{ message: string }> };
type GqlRunner = (query: string, variables?: Record<string, unknown>) => Promise<GqlResult>;

interface RawItem {
  id: string;
  title: string;
  type?: string | null;
  url?: string | null;
  resourceId?: string | null;
  tags?: string[] | null;
  items?: RawItem[] | null;
}

/** Depth-first flatten, stamping a positional path so two runs can be compared. */
function flatten(items: RawItem[] | null | undefined, depth = 1, prefix: number[] = []): ProbeItem[] {
  const out: ProbeItem[] = [];
  (items ?? []).forEach((item, index) => {
    const path = [...prefix, index + 1];
    out.push({
      id: item.id,
      title: item.title,
      type: item.type ?? null,
      url: item.url ?? null,
      resourceId: item.resourceId ?? null,
      tags: item.tags ?? [],
      depth,
      path: path.join("."),
    });
    out.push(...flatten(item.items, depth + 1, path));
  });
  return out;
}

/**
 * The read tree turned back into update input.
 *
 * `edit` renames one item; `omit` drops one (and its subtree) so the omission
 * test can measure what Shopify does with an item nobody mentioned. Anything
 * the input does not accept is dropped here rather than sent: a resourceId of
 * null on an HTTP item is not the same as an absent key.
 */
function toUpdateInput(
  items: RawItem[] | null | undefined,
  options: { renameId?: string; renameTo?: string; omitId?: string },
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const item of items ?? []) {
    if (options.omitId && item.id === options.omitId) continue;
    const node: Record<string, unknown> = {
      id: item.id,
      title: options.renameId === item.id && options.renameTo ? options.renameTo : item.title,
      type: item.type,
    };
    if (item.url) node.url = item.url;
    if (item.resourceId) node.resourceId = item.resourceId;
    if (item.tags && item.tags.length > 0) node.tags = item.tags;
    const children = toUpdateInput(item.items, options);
    if (children.length > 0) node.items = children;
    out.push(node);
  }
  return out;
}

/** GraphQL type reference to a printable string plus its NON_NULL flag. */
function printType(type: unknown): { text: string; required: boolean } {
  const node = type as { kind?: string; name?: string | null; ofType?: unknown } | null;
  if (!node) return { text: "?", required: false };
  if (node.kind === "NON_NULL") {
    const inner = printType(node.ofType);
    return { text: inner.text, required: true };
  }
  if (node.kind === "LIST") {
    const inner = printType(node.ofType);
    return { text: `[${inner.text}]`, required: false };
  }
  return { text: node.name ?? node.kind ?? "?", required: false };
}

function schemaFields(raw: unknown): SchemaField[] {
  const fields = (raw as { inputFields?: Array<{ name: string; type: unknown }> } | null)?.inputFields ?? [];
  return fields.map((f) => {
    const printed = printType(f.type);
    return { name: f.name, type: printed.text, required: printed.required };
  });
}

function userErrorText(errors: unknown): string[] {
  const list = (errors as Array<{ field?: string[] | null; message: string }> | undefined) ?? [];
  return list.map((e) => `${(e.field ?? []).join(".") || "-"}: ${e.message}`);
}

function topLevelErrors(result: GqlResult): string[] {
  return (result.errors ?? []).map((e) => e.message);
}

// ── Route ──────────────────────────────────────────────────────────────────

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return json({
    ok: true,
    hint: "POST with confirm=true to run the menu write probe. It creates and deletes its own throwaway menu.",
  });
}

export async function action({ request }: ActionFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  // Directly POST-reachable AND it writes, so the gate lives here — the same
  // class as the /api/ai handlers and the other probes.
  const settings = await db.aISettings.findUnique({
    where: { shop: session.shop },
    select: { subscriptionPlan: true },
  });
  if (!meetsPlan((settings?.subscriptionPlan || "free") as never, "pro")) {
    return json({ error: "gated" }, { status: 403 });
  }

  const formData = await request.formData().catch(() => null);
  // This probe creates a menu. That is not something to do because a URL was
  // opened, so it takes an explicit confirmation rather than defaulting to on.
  if (formData?.get("confirm") !== "true") {
    return json({ error: "confirm=true is required — this probe creates and deletes a throwaway menu." }, { status: 400 });
  }

  const run: GqlRunner = async (query, variables) => {
    const response = await admin.graphql(query, { variables: variables ?? {} });
    return (await response.json()) as GqlResult;
  };

  const stamp = `${Date.now()}`;
  const handle = `contentpilot-write-probe-${stamp}`;

  const report: MenuWriteProbeReport = {
    generatedAt: new Date().toISOString(),
    shop: session.shop,
    apiVersion: resolveApiVersionString(),
    schema: { createInput: [], updateInput: [], itemTypes: [] },
    setup: { handle, menuId: null, boundResource: null, created: false, errors: [] },
    baseline: { items: [], resourceIdStoredOnCreate: null },
    rename: {
      attempted: false,
      targetItemId: null,
      targetPath: null,
      newTitle: null,
      echoedTitle: null,
      readBackTitle: null,
      idsStable: null,
      idChanges: [],
      collateralTitleChanges: [],
      resourceIdPreserved: null,
      itemCountBefore: 0,
      itemCountAfter: 0,
      errors: [],
    },
    omission: {
      attempted: false,
      omittedItemId: null,
      omittedPath: null,
      stillPresentAfterwards: null,
      siblingsSurvived: null,
      errors: [],
    },
    translation: {
      attempted: false,
      locale: null,
      linkId: null,
      linkResolved: null,
      registered: null,
      valueBeforeRename: null,
      valueAfterRename: null,
      outdatedAfterRename: null,
      digestChanged: null,
      errors: [],
    },
    typeRoundTrip: {
      attempted: false,
      menuId: null,
      typesTried: [],
      createErrors: [],
      read: [],
      asReadOk: null,
      asReadErrors: [],
      withoutUrlOk: null,
      withoutUrlErrors: [],
    },
    cleanup: { deleted: false, typesMenuDeleted: null, errors: [] },
    verdict: [],
  };

  logger.info("[MENU-WRITE-PROBE] Starting", { context: "MenuWriteProbe", shop: session.shop, handle });

  try {
    // ── 0. Schema ──────────────────────────────────────────────────────────
    // Best effort: a shop with introspection disabled still gets every
    // empirical measurement below, and the empirical ones are the answer.
    try {
      const schemaResult = await run(INPUT_INTROSPECTION_QUERY);
      const errs = topLevelErrors(schemaResult);
      if (errs.length > 0) report.schema.error = errs.join("; ");
      report.schema.createInput = schemaFields(schemaResult.data?.createInput);
      report.schema.updateInput = schemaFields(schemaResult.data?.updateInput);
      report.schema.itemTypes =
        ((schemaResult.data?.itemType as { enumValues?: Array<{ name: string }> } | null)?.enumValues ?? []).map(
          (v) => v.name,
        );
    } catch (error) {
      report.schema.error = error instanceof Error ? error.message : String(error);
    }

    // ── 1. A resource to bind one item to ──────────────────────────────────
    // Without it the resourceId question cannot be answered at all — which is
    // reported as "not measured", never as "resourceId is fine".
    try {
      const samples = await run(SAMPLE_RESOURCES_QUERY);
      const product = (samples.data?.products as { nodes?: Array<{ id: string; title: string }> } | undefined)?.nodes?.[0];
      const collection = (samples.data?.collections as { nodes?: Array<{ id: string; title: string }> } | undefined)
        ?.nodes?.[0];
      if (product) report.setup.boundResource = { type: "PRODUCT", id: product.id, title: product.title };
      else if (collection) report.setup.boundResource = { type: "COLLECTION", id: collection.id, title: collection.title };
    } catch (error) {
      report.setup.errors.push(`Sample lookup failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // ── 2. Create the throwaway menu ───────────────────────────────────────
    const createItems: Array<Record<string, unknown>> = [
      {
        title: "CP Probe A",
        type: "HTTP",
        url: "https://example.com/cp-probe-a",
        items: [
          {
            title: "CP Probe A1",
            type: "HTTP",
            url: "https://example.com/cp-probe-a1",
            items: [
              {
                title: "CP Probe A1a",
                type: "HTTP",
                url: "https://example.com/cp-probe-a1a",
              },
            ],
          },
        ],
      },
    ];
    if (report.setup.boundResource) {
      createItems.push({
        title: "CP Probe B",
        type: report.setup.boundResource.type,
        resourceId: report.setup.boundResource.id,
      });
    }

    const createResult = await run(MENU_CREATE_MUTATION, {
      title: `ContentPilot write probe ${stamp}`,
      handle,
      items: createItems,
    });
    report.setup.errors.push(...topLevelErrors(createResult));
    const createPayload = createResult.data?.menuCreate as
      | { menu?: { id: string; handle: string } | null; userErrors?: unknown }
      | undefined;
    report.setup.errors.push(...userErrorText(createPayload?.userErrors));
    report.setup.menuId = createPayload?.menu?.id ?? null;
    report.setup.created = !!report.setup.menuId;

    if (!report.setup.menuId) {
      report.verdict.push("BLOCKED: the probe menu could not be created — nothing below was measured.");
      return json({ report });
    }
    const menuId = report.setup.menuId;

    // ── 3. Baseline read ───────────────────────────────────────────────────
    const readMenu = async (): Promise<{ items: RawItem[]; errors: string[] }> => {
      const result = await run(MENU_READ_QUERY, { id: menuId });
      const menu = result.data?.menu as { items?: RawItem[] } | null | undefined;
      return { items: menu?.items ?? [], errors: topLevelErrors(result) };
    };

    const baselineRead = await readMenu();
    report.setup.errors.push(...baselineRead.errors);
    report.baseline.items = flatten(baselineRead.items);
    if (report.setup.boundResource) {
      const bound = report.baseline.items.find((i) => i.title === "CP Probe B");
      report.baseline.resourceIdStoredOnCreate = bound?.resourceId === report.setup.boundResource.id;
    }

    const targetBefore = report.baseline.items.find((i) => i.title === "CP Probe A1");
    const grandchild = report.baseline.items.find((i) => i.title === "CP Probe A1a");

    // ── 4. Put a translation on the item we are about to rename ────────────
    // Ordered deliberately: the question is what a RENAME does to an existing
    // translation, so the translation has to exist first.
    const localesResult = await run(LOCALES_QUERY);
    const locales =
      (localesResult.data?.shopLocales as Array<{ locale: string; primary: boolean; published: boolean }> | undefined) ??
      [];
    const foreignLocale = locales.find((l) => !l.primary && l.published)?.locale ?? null;
    report.translation.locale = foreignLocale;

    let digestBefore: string | null = null;
    if (targetBefore && foreignLocale) {
      const linkId = linkGidForMenuItem(targetBefore.id);
      report.translation.linkId = linkId;
      if (linkId) {
        report.translation.attempted = true;
        try {
          const linkRead = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
          report.translation.errors.push(...topLevelErrors(linkRead));
          const resource = linkRead.data?.translatableResource as
            | { translatableContent?: Array<{ key: string; value: string | null; digest: string | null }> }
            | null
            | undefined;
          report.translation.linkResolved = !!resource;
          digestBefore = resource?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;

          if (digestBefore) {
            const registerResult = await run(REGISTER_MUTATION, {
              resourceId: linkId,
              translations: [
                {
                  key: "title",
                  locale: foreignLocale,
                  value: `CP-PROBE-TRANSLATION-${stamp}`,
                  translatableContentDigest: digestBefore,
                },
              ],
            });
            report.translation.errors.push(...topLevelErrors(registerResult));
            const registerPayload = registerResult.data?.translationsRegister as
              | { translations?: Array<{ key: string; value: string }>; userErrors?: unknown }
              | undefined;
            report.translation.errors.push(...userErrorText(registerPayload?.userErrors));
            // The echo rule: an accepted mutation is not a stored value, so
            // the value is read back fresh before it counts as registered.
            const verifyRead = await run(LINK_TRANSLATABLE_QUERY, { id: linkId, locale: foreignLocale });
            const verifyResource = verifyRead.data?.translatableResource as
              | { translations?: Array<{ key: string; value: string; outdated: boolean }> }
              | null
              | undefined;
            report.translation.valueBeforeRename =
              verifyResource?.translations?.find((t) => t.key === "title")?.value ?? null;
            report.translation.registered = !!report.translation.valueBeforeRename;
          } else {
            report.translation.errors.push("No digest on the fresh menu item's Link resource — nothing could be registered.");
            report.translation.registered = false;
          }
        } catch (error) {
          report.translation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ── 5. The rename ──────────────────────────────────────────────────────
    if (targetBefore) {
      report.rename.attempted = true;
      report.rename.targetItemId = targetBefore.id;
      report.rename.targetPath = targetBefore.path;
      report.rename.newTitle = `CP Probe A1 RENAMED ${stamp}`;
      report.rename.itemCountBefore = report.baseline.items.length;

      const updateResult = await run(MENU_UPDATE_MUTATION, {
        id: menuId,
        title: `ContentPilot write probe ${stamp}`,
        handle,
        items: toUpdateInput(baselineRead.items, {
          renameId: targetBefore.id,
          renameTo: report.rename.newTitle,
        }),
      });
      report.rename.errors.push(...topLevelErrors(updateResult));
      const updatePayload = updateResult.data?.menuUpdate as
        | { menu?: { items?: RawItem[] } | null; userErrors?: unknown }
        | undefined;
      report.rename.errors.push(...userErrorText(updatePayload?.userErrors));
      const echoed = flatten(updatePayload?.menu?.items);
      report.rename.echoedTitle = echoed.find((i) => i.id === targetBefore.id)?.title ?? null;

      // A fresh read, not the echo. The echo is what the mutation SAYS it did;
      // every rule in this codebase about translations exists because those two
      // have been observed to differ.
      const afterRead = await readMenu();
      report.rename.errors.push(...afterRead.errors);
      const after = flatten(afterRead.items);
      report.rename.itemCountAfter = after.length;
      report.rename.readBackTitle = after.find((i) => i.path === targetBefore.path)?.title ?? null;

      // Ids compared BY POSITION: comparing by id would presuppose the answer.
      const byPathBefore = new Map(report.baseline.items.map((i) => [i.path, i]));
      let idsStable = true;
      for (const item of after) {
        const before = byPathBefore.get(item.path);
        if (!before) continue;
        if (before.id !== item.id) {
          idsStable = false;
          report.rename.idChanges.push({ path: item.path, before: before.id, after: item.id });
        }
        if (before.id !== targetBefore.id && before.title !== item.title) {
          report.rename.collateralTitleChanges.push({ path: item.path, before: before.title, after: item.title });
        }
      }
      report.rename.idsStable = idsStable;

      if (report.setup.boundResource) {
        const boundAfter = after.find((i) => i.title === "CP Probe B");
        report.rename.resourceIdPreserved = boundAfter?.resourceId === report.setup.boundResource.id;
      }

      // What the rename did to the translation registered in step 4.
      if (report.translation.registered && report.translation.linkId && foreignLocale) {
        try {
          const afterTranslation = await run(LINK_TRANSLATABLE_QUERY, {
            id: report.translation.linkId,
            locale: foreignLocale,
          });
          const resource = afterTranslation.data?.translatableResource as
            | {
                translatableContent?: Array<{ key: string; digest: string | null }>;
                translations?: Array<{ key: string; value: string; outdated: boolean }>;
              }
            | null
            | undefined;
          const row = resource?.translations?.find((t) => t.key === "title");
          report.translation.valueAfterRename = row?.value ?? null;
          report.translation.outdatedAfterRename = row?.outdated ?? null;
          const digestAfter = resource?.translatableContent?.find((c) => c.key === "title")?.digest ?? null;
          report.translation.digestChanged = digestBefore !== null && digestAfter !== null ? digestBefore !== digestAfter : null;
        } catch (error) {
          report.translation.errors.push(error instanceof Error ? error.message : String(error));
        }
      }
    }

    // ── 6. Item types that are neither HTTP nor resource-bound ─────────────
    // Its own menu: a type this shop's schema will not create must not take
    // the omission test below down with it.
    const SPECIAL_TYPES = ["FRONTPAGE", "SEARCH", "CATALOG", "COLLECTIONS"];
    const typesToTry = SPECIAL_TYPES.filter(
      (t) => report.schema.itemTypes.length === 0 || report.schema.itemTypes.includes(t),
    );
    if (typesToTry.length > 0) {
      report.typeRoundTrip.attempted = true;
      report.typeRoundTrip.typesTried = typesToTry;
      const typesHandle = `${handle}-types`;
      try {
        const created = await run(MENU_CREATE_MUTATION, {
          title: `ContentPilot write probe types ${stamp}`,
          handle: typesHandle,
          items: typesToTry.map((type) => ({ title: `CP Probe ${type}`, type })),
        });
        report.typeRoundTrip.createErrors.push(...topLevelErrors(created));
        const payload = created.data?.menuCreate as
          | { menu?: { id: string } | null; userErrors?: unknown }
          | undefined;
        report.typeRoundTrip.createErrors.push(...userErrorText(payload?.userErrors));
        report.typeRoundTrip.menuId = payload?.menu?.id ?? null;

        if (report.typeRoundTrip.menuId) {
          const typesMenuId = report.typeRoundTrip.menuId;
          const readResult = await run(MENU_READ_QUERY, { id: typesMenuId });
          const readItems = ((readResult.data?.menu as { items?: RawItem[] } | null)?.items ?? []) as RawItem[];
          report.typeRoundTrip.read = readItems.map((i) => ({
            type: i.type ?? null,
            title: i.title,
            url: i.url ?? null,
            resourceId: i.resourceId ?? null,
          }));

          // Write-back #1: byte for byte what was read, which is exactly what
          // menu-write.server.ts sends.
          const asRead = await run(MENU_UPDATE_MUTATION, {
            id: typesMenuId,
            title: `ContentPilot write probe types ${stamp}`,
            handle: typesHandle,
            items: toUpdateInput(readItems, {}),
          });
          report.typeRoundTrip.asReadErrors.push(...topLevelErrors(asRead));
          const asReadPayload = asRead.data?.menuUpdate as { userErrors?: unknown } | undefined;
          report.typeRoundTrip.asReadErrors.push(...userErrorText(asReadPayload?.userErrors));
          report.typeRoundTrip.asReadOk = report.typeRoundTrip.asReadErrors.length === 0;

          // Write-back #2 only if the first failed: the same tree with `url`
          // dropped from every non-HTTP item. Two results, one rule — either
          // the url is the problem or it is not.
          if (!report.typeRoundTrip.asReadOk) {
            const stripped = toUpdateInput(readItems, {}).map((node) => {
              if (node.type === "HTTP") return node;
              const { url: _dropped, ...rest } = node as Record<string, unknown>;
              return rest;
            });
            const without = await run(MENU_UPDATE_MUTATION, {
              id: typesMenuId,
              title: `ContentPilot write probe types ${stamp}`,
              handle: typesHandle,
              items: stripped,
            });
            report.typeRoundTrip.withoutUrlErrors.push(...topLevelErrors(without));
            const withoutPayload = without.data?.menuUpdate as { userErrors?: unknown } | undefined;
            report.typeRoundTrip.withoutUrlErrors.push(...userErrorText(withoutPayload?.userErrors));
            report.typeRoundTrip.withoutUrlOk = report.typeRoundTrip.withoutUrlErrors.length === 0;
          }
        }
      } catch (error) {
        report.typeRoundTrip.createErrors.push(error instanceof Error ? error.message : String(error));
      }
    }

    // ── 7. The omission test ───────────────────────────────────────────────
    if (grandchild) {
      report.omission.attempted = true;
      report.omission.omittedItemId = grandchild.id;
      report.omission.omittedPath = grandchild.path;

      const currentRead = await readMenu();
      report.omission.errors.push(...currentRead.errors);
      const omitResult = await run(MENU_UPDATE_MUTATION, {
        id: menuId,
        title: `ContentPilot write probe ${stamp}`,
        handle,
        items: toUpdateInput(currentRead.items, { omitId: grandchild.id }),
      });
      report.omission.errors.push(...topLevelErrors(omitResult));
      const omitPayload = omitResult.data?.menuUpdate as { userErrors?: unknown } | undefined;
      report.omission.errors.push(...userErrorText(omitPayload?.userErrors));

      const afterOmit = await readMenu();
      report.omission.errors.push(...afterOmit.errors);
      const afterItems = flatten(afterOmit.items);
      report.omission.stillPresentAfterwards = afterItems.some((i) => i.id === grandchild.id);
      report.omission.siblingsSurvived = afterItems.some((i) => i.id === targetBefore?.id);
    }
  } catch (error) {
    report.setup.errors.push(`Probe aborted: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // The menu must go even when a step above threw. A leftover probe menu is
    // clutter the merchant did not ask for, and the handle is stamped so it can
    // always be found by hand if this ever fails.
    if (report.typeRoundTrip.menuId) {
      try {
        const deleteResult = await run(MENU_DELETE_MUTATION, { id: report.typeRoundTrip.menuId });
        report.cleanup.errors.push(...topLevelErrors(deleteResult));
        const payload = deleteResult.data?.menuDelete as
          | { deletedMenuId?: string | null; userErrors?: unknown }
          | undefined;
        report.cleanup.errors.push(...userErrorText(payload?.userErrors));
        report.cleanup.typesMenuDeleted = !!payload?.deletedMenuId;
      } catch (error) {
        report.cleanup.typesMenuDeleted = false;
        report.cleanup.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (report.setup.menuId) {
      try {
        const deleteResult = await run(MENU_DELETE_MUTATION, { id: report.setup.menuId });
        report.cleanup.errors.push(...topLevelErrors(deleteResult));
        const payload = deleteResult.data?.menuDelete as
          | { deletedMenuId?: string | null; userErrors?: unknown }
          | undefined;
        report.cleanup.errors.push(...userErrorText(payload?.userErrors));
        report.cleanup.deleted = !!payload?.deletedMenuId;
      } catch (error) {
        report.cleanup.errors.push(error instanceof Error ? error.message : String(error));
      }
    }
  }

  // ── Verdict ────────────────────────────────────────────────────────────────
  // Every line states what was measured, and an unmeasured question says so
  // rather than defaulting to the comfortable answer.
  const v = report.verdict;
  if (report.rename.attempted) {
    if (report.rename.readBackTitle === report.rename.newTitle) {
      v.push("RENAME: menuUpdate stores a changed item title (fresh read confirms it).");
    } else {
      v.push(`RENAME: FAILED — read back "${report.rename.readBackTitle ?? "(nothing)"}" instead of the new title.`);
    }
    if (report.rename.idsStable === true) {
      v.push("IDS: every MenuItem kept its id across the update — translations (gid://shopify/Link/<same number>) survive a rename.");
    } else if (report.rename.idsStable === false) {
      v.push(
        `IDS: ⚠️ Shopify reassigned ${report.rename.idChanges.length} item id(s). A rename ORPHANS those items' translations — the feature must migrate or refuse.`,
      );
    }
    if (report.rename.collateralTitleChanges.length > 0) {
      v.push(`⚠️ ${report.rename.collateralTitleChanges.length} untouched item(s) changed title as a side effect.`);
    }
    if (report.rename.itemCountAfter !== report.rename.itemCountBefore) {
      v.push(`⚠️ Item count changed ${report.rename.itemCountBefore} -> ${report.rename.itemCountAfter} on a pure rename.`);
    }
  }
  if (report.rename.resourceIdPreserved === true) {
    v.push("RESOURCE BINDING: a resource-bound item keeps its resourceId when it is sent back.");
  } else if (report.rename.resourceIdPreserved === false) {
    v.push("RESOURCE BINDING: ⚠️ the resourceId did NOT survive the round trip.");
  } else {
    v.push("RESOURCE BINDING: not measured (no product or collection to bind to).");
  }
  if (report.omission.stillPresentAfterwards === true) {
    v.push("OMISSION: an item left out of the list SURVIVED — menuUpdate is not a full replace.");
  } else if (report.omission.stillPresentAfterwards === false) {
    v.push("OMISSION: an item left out of the list was DELETED — menuUpdate replaces the whole tree, as the write path assumes.");
  }
  if (report.translation.registered) {
    if (report.translation.valueAfterRename) {
      v.push(
        `TRANSLATION: survived the rename${report.translation.outdatedAfterRename ? " and is flagged outdated" : " and is NOT flagged outdated"}.`,
      );
    } else {
      v.push("TRANSLATION: ⚠️ gone after the rename — a primary edit destroys the translation.");
    }
  } else if (report.translation.attempted) {
    v.push("TRANSLATION: not measured — the probe translation could not be registered.");
  }
  if (report.typeRoundTrip.asReadOk === true) {
    v.push(
      `ITEM TYPES: a whole-tree write-back with url present is accepted for ${report.typeRoundTrip.typesTried.join(", ")} — the write path may keep sending what it read.`,
    );
  } else if (report.typeRoundTrip.asReadOk === false) {
    v.push(
      report.typeRoundTrip.withoutUrlOk
        ? "ITEM TYPES: ⚠️ the write-back is REFUSED while url is present on a non-HTTP item, and accepted without it — the write path must strip url for those types."
        : "ITEM TYPES: ⚠️ the write-back is REFUSED for these types, and dropping url does not fix it — see the errors below.",
    );
  } else if (report.typeRoundTrip.attempted) {
    v.push("ITEM TYPES: not measured — the second probe menu could not be created.");
  }
  if (report.typeRoundTrip.menuId && report.cleanup.typesMenuDeleted === false) {
    v.push(`⚠️ CLEANUP FAILED — delete the menu "${report.setup.handle}-types" by hand in the Shopify admin.`);
  }
  if (!report.cleanup.deleted && report.setup.created) {
    v.push(`⚠️ CLEANUP FAILED — delete the menu "${report.setup.handle}" by hand in the Shopify admin.`);
  }

  logger.info("[MENU-WRITE-PROBE] Done", {
    context: "MenuWriteProbe",
    shop: session.shop,
    created: report.setup.created,
    deleted: report.cleanup.deleted,
    idsStable: String(report.rename.idsStable),
  });

  return json({ report });
}
