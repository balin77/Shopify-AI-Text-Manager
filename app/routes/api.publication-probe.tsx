/**
 * What does this shop's product publishing actually look like?
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 * `resourcePublicationsV2` DEFAULTS to `catalogType: APP` and says nothing
 * about it. This app read that default for months, grouped the answer by
 * catalog type, and told merchants their regions were sales channels — on a
 * list that could only ever hold sales channels. The documentation says one
 * thing; what a given shop, on a given API version, with a given set of
 * scopes actually returns is another, and only a measurement settles it.
 *
 * So this route asks all three connections for ONE product and reports each
 * separately, together with whether the call succeeded at all. It answers, in
 * one click and per shop:
 *
 *   - Do market (region) catalogs come back, and under which names?
 *   - Do B2B company-location catalogs?
 *   - Which sales channels are there — in particular, is Shopify's "Agentic"
 *     channel among them, and what is it called? The admin's dialog lists it
 *     under a heading of its own, which does not say whether the API models it
 *     as an ordinary AppCatalog or as something this app has never seen.
 *
 * ── Every failure is REPORTED, never rendered as an empty list ──────────────
 * A refused connection and a shop with no regions look identical in a list of
 * zero. Each block therefore carries its own `ok` plus the error, and the UI
 * says "could not ask" rather than "there are none" — the same rule the panel
 * itself now follows through `catalogsKnown`.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { logger } from "~/utils/logger.server";

/** One connection's answer: what came back, or why nothing did. */
export interface ProbeCatalogBlock {
  ok: boolean;
  error?: string;
  truncated: boolean;
  rows: Array<{
    publicationId: string;
    /** `Publication.name` verbatim — EMPTY for a market catalog, measured. */
    name: string;
    /** `Catalog.title` — `String!`, and what names a region in the admin. */
    catalogTitle: string;
    catalogTypename: string;
    /**
     * `null` = NOT APPLICABLE, not "no". The shop-wide block lists what
     * exists, which has no per-product state — reporting `false` there told
     * the reader a live Online Store was unpublished.
     */
    isPublished: boolean | null;
    publishDate: string | null;
  }>;
}

export interface PublicationProbeResult {
  productId: string;
  productTitle: string;
  /** `catalogType` omitted — what the app used to read, and only that. */
  defaultCatalogType: ProbeCatalogBlock;
  market: ProbeCatalogBlock;
  companyLocation: ProbeCatalogBlock;
  /**
   * Every publication the SHOP has, product-independent.
   *
   * The other three say where THIS product may go. This one says what exists
   * at all — which is the only way to tell "the product cannot be published
   * there" apart from "this app never sees that channel". It is what answers
   * whether Shopify's Agentic channel is a publication in the first place.
   */
  shopPublications: ProbeCatalogBlock;
}

const PAGE = 50;

const NODES = `
      pageInfo { hasNextPage }
      nodes {
        isPublished
        publishDate
        publication { id name catalog { __typename title } }
      }`;

type RawConnection = {
  pageInfo?: { hasNextPage?: boolean } | null;
  nodes?: Array<{
    isPublished?: boolean | null;
    publishDate?: string | null;
    publication?: {
      id?: string | null;
      name?: string | null;
      catalog?: { __typename?: string | null; title?: string | null } | null;
    } | null;
  }> | null;
} | null;

function toBlock(connection: RawConnection | undefined): ProbeCatalogBlock {
  return {
    ok: true,
    truncated: connection?.pageInfo?.hasNextPage === true,
    rows: (connection?.nodes ?? []).flatMap((node) => {
      const publicationId = node?.publication?.id;
      if (!publicationId) return [];
      return [{
        publicationId,
        name: node.publication?.name ?? "",
        catalogTitle: node.publication?.catalog?.title ?? "",
        // The measurement everything else hangs on. Absent is its own answer:
        // a publication whose catalog Shopify did not deliver.
        catalogTypename: node.publication?.catalog?.__typename ?? "(none)",
        isPublished: node.isPublished === true,
        publishDate: node.publishDate ?? null,
      }];
    }),
  };
}

const failed = (error: string): ProbeCatalogBlock => ({ ok: false, error, truncated: false, rows: [] });

export async function loader({ request }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);

  // Directly GET-reachable, so the gate lives HERE and not only in the
  // settings tab that renders it — the same rule the other probes follow.
  if (process.env.APP_ENV !== "development") {
    return json({ success: false, error: "Not available." }, { status: 403 });
  }

  const url = new URL(request.url);

  // A product to ask about: the caller's, or the shop's first cached one — the
  // probe should work without the merchant hunting for a GID.
  let productId = url.searchParams.get("productId") || "";
  let productTitle = "";
  if (!productId) {
    const row = await db.product.findFirst({
      where: { shop: session.shop },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    });
    if (!row) {
      return json({ success: false, error: "No product is cached for this shop yet — run a sync first." }, { status: 400 });
    }
    productId = row.id;
    productTitle = row.title ?? "";
  }
  if (!productId.startsWith("gid://shopify/Product/")) {
    return json({ success: false, error: "A product id is required." }, { status: 400 });
  }

  /** One connection, asked on its own so one refusal cannot hide the others. */
  const ask = async (argument: string): Promise<ProbeCatalogBlock> => {
    try {
      const response = await admin.graphql(
        `#graphql
          query publicationProbe($id: ID!) {
            product(id: $id) {
              title
              resourcePublicationsV2(first: ${PAGE}, onlyPublished: false${argument}) {${NODES}
              }
            }
          }`,
        { variables: { id: productId } },
      );
      const body = (await response.json()) as {
        data?: { product?: { title?: string | null; resourcePublicationsV2?: RawConnection } | null };
        errors?: Array<{ message?: string }>;
      };
      // A schema-level error is a top-level `errors` array with `data: null` —
      // the exact shape that reads as "no data" if nobody looks.
      if (body.errors?.length) return failed(body.errors[0]?.message ?? "unknown error");
      if (!body.data?.product) return failed("product not found");
      if (!productTitle) productTitle = body.data.product.title ?? "";
      return toBlock(body.data.product.resourcePublicationsV2);
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

  /**
   * The shop's own publication list, product-independent.
   *
   * Asked across all three catalog types, because `publications` takes the
   * SAME `catalogType` filter whose silent default this route exists to
   * expose — a shop block built without it would omit the regions and then
   * invite the conclusion that the app never sees them. On a refusal it falls
   * back to the unfiltered call and the block reports itself as partial.
   */
  const askShop = async (): Promise<ProbeCatalogBlock> => {
    const CONNECTION = `
              pageInfo { hasNextPage }
              nodes {
                id
                name
                catalog { __typename title }
              }`;
    type ShopConnection = {
      pageInfo?: { hasNextPage?: boolean } | null;
      nodes?: Array<{
        id?: string | null;
        name?: string | null;
        catalog?: { __typename?: string | null; title?: string | null } | null;
      }> | null;
    } | null;

    const send = (withCatalogs: boolean) =>
      admin.graphql(
        `#graphql
          query shopPublicationProbe {
            publications(first: ${PAGE}) {${CONNECTION}
            }
            ${withCatalogs ? `marketPublications: publications(first: ${PAGE}, catalogType: MARKET) {${CONNECTION}
            }
            companyLocationPublications: publications(first: ${PAGE}, catalogType: COMPANY_LOCATION) {${CONNECTION}
            }` : ""}
          }`,
      );

    try {
      type ShopBody = {
        data?: {
          publications?: ShopConnection;
          marketPublications?: ShopConnection;
          companyLocationPublications?: ShopConnection;
        };
        errors?: Array<{ message?: string }>;
      };
      let partial = false;
      let body = (await (await send(true)).json()) as ShopBody;
      if (body.errors?.length) {
        partial = true;
        body = (await (await send(false)).json()) as ShopBody;
      }
      if (body.errors?.length) return failed(body.errors[0]?.message ?? "unknown error");
      const parts = [body.data?.publications, body.data?.marketPublications, body.data?.companyLocationPublications];
      if (!parts[0]) return failed("no publications block");

      const seen = new Set<string>();
      const rows: ProbeCatalogBlock["rows"] = [];
      for (const node of parts.flatMap((part) => part?.nodes ?? [])) {
        if (!node?.id || seen.has(node.id)) continue;
        seen.add(node.id);
        rows.push({
          publicationId: node.id,
          name: node.name ?? "",
          catalogTitle: node.catalog?.title ?? "",
          catalogTypename: node.catalog?.__typename ?? "(none)",
          // Not a product question — the shop either has the publication or it
          // does not, so there is no per-product state to report.
          isPublished: null,
          publishDate: null,
        });
      }
      return {
        ok: true,
        // Partial also counts as truncated: the reader must not take a
        // catalog-filtered gap for "this shop has none".
        truncated: partial || parts.some((part) => part?.pageInfo?.hasNextPage === true),
        rows,
      };
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  };

  const [defaultCatalogType, market, companyLocation, shopPublications] = await Promise.all([
    ask(""),
    ask(", catalogType: MARKET"),
    ask(", catalogType: COMPANY_LOCATION"),
    askShop(),
  ]);

  logger.info("[PublicationProbe] Measured", {
    context: "PublicationProbe",
    shop: session.shop,
    defaultRows: defaultCatalogType.rows.length,
    marketOk: market.ok,
    marketRows: market.rows.length,
    b2bOk: companyLocation.ok,
    b2bRows: companyLocation.rows.length,
    shopOk: shopPublications.ok,
    shopRows: shopPublications.rows.length,
  });

  return json({
    success: true,
    productId,
    productTitle,
    defaultCatalogType,
    market,
    companyLocation,
    shopPublications,
  } satisfies { success: true } & PublicationProbeResult);
}
