/**
 * What Shopify's product taxonomy hands over — measured, before a picker is
 * built on top of it.
 *
 * The shipped [TaxonomyField](../components/unified/TaxonomyField.tsx) can only
 * SEARCH. Turning it into Shopify's own control — a dropdown you can either
 * search or click your way down — needs three answers the documentation does
 * not give and that this container cannot fetch (shopify.dev, help.shopify.com
 * and changelog.shopify.com are all blocked by the egress proxy here):
 *
 *   T1  Is a bare `categories(first: n)` the ROOT list, or the first n of all
 *       ~10 000? PLAN_METAOBJECT_TAXONOMY_CREATE §1.2 labelled it "top-level"
 *       but never checked a node's own level — and a picker whose first screen
 *       is an arbitrary alphabetical slice of the whole taxonomy is worse than
 *       no picker.
 *   T2  Does `childrenOf` return the DIRECT children (one level) or everything
 *       below? `descendantsOf` exists as a separate argument, which makes the
 *       first likely — likely is not measured.
 *   T3  Can a category name be read in ANOTHER LANGUAGE? This decides how the
 *       auto-filled product type gets translated: from Shopify's own localized
 *       taxonomy (authoritative, free) or through this app's AI path (a
 *       machine translation of a term Shopify has already translated itself).
 *       ANSWERED NO, 2026-08-19: the API returns ENGLISH names on a shop whose
 *       admin renders German ones; `@inContext` is not defined in the Admin
 *       schema at all, and `Accept-Language` is accepted and changes nothing
 *       for any locale of the shop, its primary one included. The step is kept
 *       so the answer is one click away again if Shopify ever adds a door —
 *       and because "accepted but identical" is exactly the result a future
 *       reader would otherwise assume had never been tested.
 *
 * Two rules this probe inherits from every other one in this app. A FAILED
 * call is never reported as a NEGATIVE answer — `missing` (the API answered
 * and the thing is not there) and `error` (no answer arrived) are separate
 * states, because one throttled response read as "not supported" closes a
 * question that is actually open. And the SCHEMA is asked before anything is
 * attempted: the metaobject probe cost two runs by guessing `taxonomy
 * .attributes` into existence, so here the selections and the directive test
 * are built from introspection rather than from memory.
 *
 * READ-ONLY: nothing here writes, and the taxonomy is Shopify's data, not the
 * shop's. Dev-gated anyway, like every probe — a diagnostic that fans out
 * queries is not a feature, and a hidden Settings tab is not a permission
 * check since this route takes a direct GET.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { logger } from "~/utils/logger.server";

/** One answered question. `missing` and `error` are NOT the same answer. */
export interface TaxonomyFinding {
  ok: boolean;
  /** The API answered, and what was asked for is not there. */
  missing?: boolean;
  /** No answer arrived. Never read this as a "no". */
  error?: string;
  detail?: unknown;
}

export type TaxonomyProbeReport = Record<string, TaxonomyFinding>;

/** Everything a picker could want off a node. Asked for only where the schema
 *  says it exists — an unknown field fails the WHOLE query, which would report
 *  a present capability as absent. */
const WANTED_NODE_FIELDS = [
  "id",
  "name",
  "fullName",
  "level",
  "isLeaf",
  "isRoot",
  "parentId",
  "childrenIds",
  "ancestorIds",
] as const;

/** Bounded on purpose. `categories(n) x attributes(m)` already blew the Admin
 *  API's 1000-point ceiling once in this repo, and that failure was then
 *  reported as "no path exists". Nothing here nests. */
const ROOT_PAGE = 60;
const CHILD_PAGE = 50;
const SEARCH_PAGE = 10;

interface CallResult {
  ok: boolean;
  data?: any;
  /** Top-level GraphQL errors — a schema refusal arrives here with data: null
   *  and never as a userError. */
  errors?: string[];
  /** The request itself did not complete. */
  thrown?: string;
}

async function call(
  admin: AdminApiContext,
  query: string,
  variables?: Record<string, unknown>,
  /** Request headers. The `Accept-Language` test is the only user. */
  headers?: Record<string, string>,
): Promise<CallResult> {
  try {
    const response = await admin.graphql(query, {
      ...(variables ? { variables } : {}),
      ...(headers ? { headers } : {}),
    } as never);
    const body = (await response.json()) as {
      data?: any;
      errors?: Array<{ message?: string }>;
    };
    const errors = (body.errors ?? []).map((e) => e?.message ?? "unknown error");
    return { ok: errors.length === 0 && !!body.data, data: body.data, errors: errors.length ? errors : undefined };
  } catch (error) {
    return { ok: false, thrown: error instanceof Error ? error.message : String(error) };
  }
}

function describe(result: CallResult): string {
  if (result.thrown) return `request failed: ${result.thrown}`;
  if (result.errors?.length) return result.errors.join(" | ");
  return "the response carried no data";
}

/** A shop locale as Shopify's `LanguageCode` enum spells it: "pt-BR" -> PT_BR.
 *  Sanitised rather than trusted, because it is interpolated into a document. */
function languageEnum(locale: string): string | null {
  const candidate = locale.trim().toUpperCase().replace(/-/g, "_");
  return /^[A-Z]{2}(_[A-Z0-9]{2,4})?$/.test(candidate) ? candidate : null;
}

function nodesOf(data: any): any[] {
  const nodes = data?.taxonomy?.categories?.nodes;
  return Array.isArray(nodes) ? nodes.filter(Boolean) : [];
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  if (process.env.APP_ENV !== "development") {
    return json(
      { success: false, error: "The taxonomy probe is a development-only diagnostic." },
      { status: 403 },
    );
  }

  const report: TaxonomyProbeReport = {};

  try {
    // ── S0. The schema, before anything is attempted ────────────────────────
    // Which arguments `categories` really takes, and which fields a node
    // really carries. Everything below selects out of THIS answer.
    const argsProbe = await call(
      admin,
      `#graphql
        query TaxonomyProbeCategoriesArgs {
          __type(name: "Taxonomy") {
            fields {
              name
              args { name type { kind name ofType { kind name } } }
            }
          }
        }`,
    );
    const categoriesField = (argsProbe.data?.__type?.fields ?? []).find((f: any) => f?.name === "categories");
    const categoryArgs: string[] = (categoriesField?.args ?? []).map((a: any) => String(a?.name ?? ""));
    report.categoriesArguments = argsProbe.ok
      ? {
          ok: categoryArgs.length > 0,
          missing: categoryArgs.length === 0,
          detail: categoryArgs.length > 0 ? categoryArgs : "Taxonomy.categories reported no arguments",
        }
      : { ok: false, error: describe(argsProbe) };

    const nodeProbe = await call(
      admin,
      `#graphql
        query TaxonomyProbeCategoryFields {
          __type(name: "TaxonomyCategory") { fields { name } }
        }`,
    );
    const nodeFields: string[] = (nodeProbe.data?.__type?.fields ?? []).map((f: any) => String(f?.name ?? ""));
    const selectable = WANTED_NODE_FIELDS.filter((f) => nodeFields.includes(f));
    report.categoryFields = nodeProbe.ok
      ? {
          ok: selectable.length > 0,
          missing: selectable.length === 0,
          detail: {
            selectable,
            absent: WANTED_NODE_FIELDS.filter((f) => !nodeFields.includes(f)),
            all: nodeFields,
          },
        }
      : { ok: false, error: describe(nodeProbe) };

    // Without a usable selection nothing below can run. Reported as an
    // unanswered question, not as three negative ones.
    if (selectable.length === 0) {
      return json({ success: true, shop: session.shop, report });
    }
    const SELECTION = selectable.join(" ");

    // The directive that would carry a language. Asked of the schema rather
    // than tried blind, so "the directive does not exist" and "the taxonomy
    // ignores it" stay distinguishable — they mean different things for T3.
    const directiveProbe = await call(
      admin,
      `#graphql
        query TaxonomyProbeInContextDirective {
          __schema { directives { name args { name } } }
        }`,
    );
    const inContext = (directiveProbe.data?.__schema?.directives ?? []).find(
      (d: any) => d?.name === "inContext",
    );
    const inContextArgs: string[] = (inContext?.args ?? []).map((a: any) => String(a?.name ?? ""));
    report.inContextDirective = directiveProbe.ok
      ? {
          ok: inContextArgs.includes("language"),
          missing: !inContext || !inContextArgs.includes("language"),
          detail: inContext ? inContextArgs : "no @inContext directive in this schema",
        }
      : { ok: false, error: describe(directiveProbe) };

    // ── T1. Is a bare categories() the ROOT list? ───────────────────────────
    const rootsResult = await call(
      admin,
      `#graphql
        query TaxonomyProbeRoots($first: Int!) {
          taxonomy {
            categories(first: $first) {
              nodes { ${SELECTION} }
              pageInfo { hasNextPage }
            }
          }
        }`,
      { first: ROOT_PAGE },
    );
    const roots = nodesOf(rootsResult.data);
    // A node is a root if the schema says so, else if its level is 0, else if
    // its path has no separator. Three fallbacks because which of the fields
    // exists is exactly what S0 just measured, and a missing field must not
    // turn into a confident "not a root".
    const looksRoot = (n: any): boolean => {
      if (typeof n?.isRoot === "boolean") return n.isRoot;
      if (typeof n?.level === "number") return n.level === 0;
      if (typeof n?.fullName === "string") return !n.fullName.includes(">");
      return false;
    };
    const rootCount = roots.filter(looksRoot).length;
    report.rootList = rootsResult.ok
      ? {
          // Only a CLEAN sweep answers T1 yes. One non-root among them means
          // the bare call is a slice of everything, and the picker needs a
          // different entry point.
          ok: roots.length > 0 && rootCount === roots.length,
          detail: {
            returned: roots.length,
            lookRoot: rootCount,
            hasNextPage: rootsResult.data?.taxonomy?.categories?.pageInfo?.hasNextPage ?? null,
            verdict:
              roots.length === 0
                ? "no categories came back"
                : rootCount === roots.length
                  ? "every node is a root — a bare categories() IS the top level"
                  : `only ${rootCount} of ${roots.length} are roots — the bare call is a slice of the whole taxonomy`,
            sample: roots.slice(0, 40).map((n) => ({
              id: n.id,
              name: n.name,
              fullName: n.fullName,
              level: n.level,
              isRoot: n.isRoot,
              isLeaf: n.isLeaf,
            })),
          },
        }
      : { ok: false, error: describe(rootsResult) };

    // ── T2. childrenOf: one level, or everything below? ─────────────────────
    const firstRoot = roots.find(looksRoot) ?? roots[0];
    if (!categoryArgs.includes("childrenOf")) {
      report.childrenOf = {
        ok: false,
        missing: true,
        detail: "the schema reports no childrenOf argument — click-through would have to page descendantsOf",
      };
    } else if (!firstRoot?.id) {
      report.childrenOf = { ok: false, error: "no category to descend from — T1 answered nothing" };
    } else {
      const childResult = await call(
        admin,
        `#graphql
          query TaxonomyProbeChildren($parent: ID!, $first: Int!) {
            taxonomy {
              categories(childrenOf: $parent, first: $first) {
                nodes { ${SELECTION} }
                pageInfo { hasNextPage }
              }
            }
          }`,
        { parent: firstRoot.id, first: CHILD_PAGE },
      );
      const children = nodesOf(childResult.data);
      // Direct children sit exactly one level below their parent. Where the
      // schema carries neither `level` nor `parentId`, the path depth answers
      // it: "A > B" under "A" is direct, "A > B > C" is not.
      const depthOf = (n: any): number | null =>
        typeof n?.level === "number"
          ? n.level
          : typeof n?.fullName === "string"
            ? n.fullName.split(">").length - 1
            : null;
      const parentDepth = depthOf(firstRoot);
      const direct = children.filter((n) => {
        if (typeof n?.parentId === "string") return n.parentId === firstRoot.id;
        const d = depthOf(n);
        return d !== null && parentDepth !== null && d === parentDepth + 1;
      });
      report.childrenOf = childResult.ok
        ? {
            ok: children.length > 0 && direct.length === children.length,
            detail: {
              parent: firstRoot.fullName ?? firstRoot.name ?? firstRoot.id,
              returned: children.length,
              direct: direct.length,
              hasNextPage: childResult.data?.taxonomy?.categories?.pageInfo?.hasNextPage ?? null,
              verdict:
                children.length === 0
                  ? "no children came back"
                  : direct.length === children.length
                    ? "every node is a DIRECT child — one level per call, which is what a click-through needs"
                    : `${children.length - direct.length} nodes sit deeper — childrenOf returns descendants`,
              sample: children.slice(0, 25).map((n) => ({
                id: n.id,
                fullName: n.fullName,
                level: n.level,
                isLeaf: n.isLeaf,
                parentId: n.parentId,
              })),
            },
          }
        : { ok: false, error: describe(childResult) };

      // One level deeper, because a call that works at the top and not below
      // it would strand the picker on screen two.
      const branch = children.find((n) => n?.isLeaf === false) ?? children[0];
      if (branch?.id) {
        const deepResult = await call(
          admin,
          `#graphql
            query TaxonomyProbeGrandchildren($parent: ID!, $first: Int!) {
              taxonomy {
                categories(childrenOf: $parent, first: $first) {
                  nodes { ${SELECTION} }
                }
              }
            }`,
          { parent: branch.id, first: CHILD_PAGE },
        );
        const deep = nodesOf(deepResult.data);
        report.childrenOfDepth2 = deepResult.ok
          ? {
              ok: deep.length > 0,
              detail: {
                parent: branch.fullName ?? branch.id,
                returned: deep.length,
                sample: deep.slice(0, 15).map((n) => n.fullName ?? n.name),
              },
            }
          : { ok: false, error: describe(deepResult) };
      }
    }

    // ── Can a SEARCH hit be opened in the tree? ─────────────────────────────
    // A picker that searches and clicks needs to place a hit in the hierarchy,
    // or the two halves are separate tools sharing a popover.
    const searchResult = await call(
      admin,
      `#graphql
        query TaxonomyProbeSearch($search: String!, $first: Int!) {
          taxonomy {
            categories(search: $search, first: $first) {
              nodes { ${SELECTION} }
            }
          }
        }`,
      { search: "vase", first: SEARCH_PAGE },
    );
    const hits = nodesOf(searchResult.data);
    report.searchHitShape = searchResult.ok
      ? {
          ok: hits.length > 0,
          detail: {
            returned: hits.length,
            carriesAncestors: hits.some((n) => Array.isArray(n?.ancestorIds) && n.ancestorIds.length > 0),
            carriesParent: hits.some((n) => typeof n?.parentId === "string" && n.parentId.length > 0),
            sample: hits.slice(0, 10).map((n) => ({
              fullName: n.fullName,
              level: n.level,
              parentId: n.parentId,
              ancestorIds: n.ancestorIds,
            })),
          },
        }
      : { ok: false, error: describe(searchResult) };

    // ── T3. The same categories, in the shop's other languages ──────────────
    //
    // MEASURED 2026-08-19: the bare query returns ENGLISH names ("Animals &
    // Pet Supplies") on a shop whose admin renders them in German ("Tiere &
    // Tierbedarf"), and `@inContext` is NOT DEFINED in the Admin schema at all
    // — a closed door rather than a failed attempt. The one remaining way to
    // ask for a language over this transport is the HTTP `Accept-Language`
    // header, which is what this now tests.
    //
    // The PRIMARY locale is tested first and matters most: it decides whether
    // a product type derived from a category can be in the merchant's own
    // language at all, or arrives as an English word in a German shop.
    const localesResult = await call(
      admin,
      `#graphql
        query TaxonomyProbeShopLocales {
          shopLocales { locale primary published }
        }`,
    );
    const shopLocales: Array<{ locale: string; primary: boolean }> =
      (localesResult.data?.shopLocales ?? []).filter(Boolean);
    const targets = [
      ...shopLocales.filter((l) => l.primary),
      ...shopLocales.filter((l) => !l.primary).slice(0, 3),
    ];

    if (!localesResult.ok) {
      report.localizedNames = { ok: false, error: describe(localesResult) };
    } else if (targets.length === 0) {
      report.localizedNames = {
        ok: false,
        missing: true,
        detail: "no shop locales came back — nothing to ask the question in",
      };
    } else {
      // Compared against the ids from T1, so "the header was accepted" and
      // "the names actually changed" stay two separate results. A silently
      // ignored header returns the same names with no error at all, which is
      // the outcome that would otherwise be read as success.
      const baseline = new Map<string, string>(
        roots.filter((n) => n?.id && n?.name).map((n) => [String(n.id), String(n.name)]),
      );
      const perLocale: Record<string, unknown> = {};
      let anyTranslated = false;

      for (const target of targets) {
        const localized = await call(
          admin,
          `#graphql
            query TaxonomyProbeLocalizedRoots($first: Int!) {
              taxonomy {
                categories(first: $first) {
                  nodes { id name fullName }
                }
              }
            }`,
          { first: Math.min(ROOT_PAGE, 20) },
          // A weighted list, the way a browser sends one, with English last so
          // a server that honours the header has something to fall back to.
          { "Accept-Language": `${target.locale};q=1.0, en;q=0.1` },
        );
        if (!localized.ok) {
          perLocale[target.locale] = {
            primary: target.primary,
            verdict: "refused",
            detail: describe(localized),
          };
          continue;
        }
        const localizedNodes = nodesOf(localized.data);
        const changed = localizedNodes.filter(
          (n) => n?.id && baseline.has(String(n.id)) && baseline.get(String(n.id)) !== String(n.name),
        );
        if (changed.length > 0) anyTranslated = true;
        perLocale[target.locale] = {
          primary: target.primary,
          verdict:
            changed.length > 0
              ? "TRANSLATED — Accept-Language reaches the taxonomy"
              : "accepted but IDENTICAL — the header changes nothing here",
          compared: localizedNodes.length,
          changed: changed.length,
          sample: changed.slice(0, 10).map((n) => ({
            id: n.id,
            baseline: baseline.get(String(n.id)),
            localized: n.name,
          })),
        };
      }

      report.localizedNames = {
        ok: anyTranslated,
        detail: {
          verdict: anyTranslated
            ? "the picker can show localized paths, and a derived product type can be filled in the merchant's own language"
            : "no locale came back translated — this API speaks English, whatever the admin renders",
          note:
            "@inContext is not defined in the Admin schema (measured), so this header is the only remaining door over this transport.",
          perLocale,
        },
      };
    }

    return json({ success: true, shop: session.shop, report });
  } catch (error) {
    logger.error("[TaxonomyProbe] Run failed", {
      context: "TaxonomyProbe",
      shop: session.shop,
      error: error instanceof Error ? error.message : String(error),
    });
    return json(
      { success: false, error: error instanceof Error ? error.message : String(error), report },
      { status: 500 },
    );
  }
};
