/**
 * Structured Data (JSON-LD) section (SEO_TAB_IMPLEMENTATION_PLAN.md Phase 2 / A3).
 *
 * A read/preview/status page that reuses the existing structured-data.service
 * builders. The actual markup is emitted on the storefront by the theme app
 * embed (extensions/structured-data) from native Liquid objects — there is no
 * app-owned config here, so this route has no action/state. It shows:
 *   - activation status (cannot be detected via API → "unknown" + deep-link)
 *   - which schema types apply
 *   - a live in-app preview built from one example item per type + validation
 *
 * The theme-editor deep-link uses the app client_id (SHOPIFY_API_KEY) and the
 * block handle `structured-data`, per A3.
 *
 * Preview/storefront drift (documented, not a bug — plan §C1/§C2): the
 * product preview is built from the DB cache, which has neither
 * `ProductVariant.barcode` (GTIN) nor the Shopify standard review-app rating
 * metafields (`reviews.rating` / `reviews.rating_count`). The preview simply
 * omits `gtin*`/`aggregateRating` in that case — the storefront Liquid block
 * still emits them in full from native/metafield data, so there is no drift
 * in what actually ships, only in what this in-app preview can show.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useRevalidator } from "react-router";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Card, Box, BlockStack, InlineStack, InlineGrid, Text, Badge, Button, Banner, DataTable } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { useAppNavigation } from "../hooks/useAppNavigation";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import { SeoHelpBanner } from "../components/seo/SeoHelpBanner";
import { StepTile } from "../components/seo/StepTile";
import {
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  renderJsonLdScript,
  validateJsonLd,
  slugify,
  GOOGLE_RICH_RESULTS_TEST,
  type ShopInfo,
  type JsonLdWarning,
} from "../services/structured-data.service";
import { getMainThemeId, readThemeFile } from "../services/seo/aeo.service";
import { summarizeLiveJsonLd } from "../services/seo/json-ld-audit.service";
import type { JsonLdAuditAggregate, JsonLdAuditItemType } from "../services/seo/json-ld-audit.service";
import { summarizeLiveSocial } from "../services/seo/social-audit.service";
import {
  APP_SOCIAL_TAGS,
  actionTone,
  activationGate,
  embedBadgeVerdict,
  scopeCovered,
  activationTone,
  groupGatesByAction,
  statForSwitch,
  worstActivationVerdict,
  JSON_LD_SWITCHES,
  type ActivationVerdict,
} from "../services/seo/markup-activation.shared";

/**
 * Render `**bold**` inside an i18n string.
 *
 * This section's copy is read under time pressure by someone deciding whether
 * to flip a switch, and the deciding words ("Nicht einschalten", "Ausschalten")
 * have to survive a glance. Keeping the emphasis IN the translated string keeps
 * it where a translator can move it — German and Spanish do not stress the same
 * word as English — instead of hard-coding which half of a sentence is bold.
 *
 * Deliberately not markdown: only `**` pairs, no links, no nesting. An unpaired
 * `**` renders literally rather than swallowing the rest of the sentence.
 */
function emphasize(text: string): ReactNode[] {
  return text.split("**").map((part, i) =>
    i % 2 === 1 ? (
      <Text key={i} as="span" fontWeight="bold">{part}</Text>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

/** Extract the trailing numeric id from a GID like "gid://shopify/Product/123". */
function gidToNumericId(gid: string | null | undefined): string | null {
  if (!gid) return null;
  const m = gid.match(/(\d+)(?:\?|$)/);
  return m ? m[1] : null;
}

interface PreviewBlock {
  labelKey: string;
  code: string;
  warnings: JsonLdWarning[];
}

// The DB lacks the fields the schema.org validator needs to check the SEO-
// relevant warnings — Product has no price/currency/availability columns
// (variants don't either), Article has no publishedAt. We fetch those bits
// live from Admin GraphQL for the sample product/article we've picked, so
// the preview reflects the same data the storefront Liquid block emits.
//
// FIELD-EXISTENCE NOTES (Admin API 2025-10 — hit at runtime, do not "re-add"):
//   • `Shop.brand`: NOT queryable from the Admin API root schema (schema error:
//     "Field 'brand' doesn't exist on type 'Shop'"). Brand assets live under
//     the online-store surface here and are only readable via Liquid on the
//     storefront (which the app-embed structured-data block already does).
//     Consequence: we cannot detect a shop's brand logo in-app — the
//     Organization JSON-LD preview is emitted without `logo`, and the
//     resulting "no logo" warning is escalated with a deep-link to
//     Settings → Brand so the merchant fixes it in one click.
//   • `Product.availableForSale`: NOT on the Admin `Product` type; the field
//     lives on `ProductVariant`. We read the first variant's availability
//     (matches the storefront Liquid block's `product.available` semantics
//     closely enough for the preview) and use `priceRangeV2` for price.
const SHOP_INFO_QUERY = `#graphql
  query seoStructuredDataShop {
    shop {
      name
      primaryDomain { host }
    }
  }
`;

const PRODUCT_SAMPLE_QUERY = `#graphql
  query seoStructuredDataProduct($id: ID!) {
    product(id: $id) {
      featuredImage { url }
      images(first: 1) { edges { node { url } } }
      priceRangeV2 { minVariantPrice { amount currencyCode } }
      variants(first: 1) { edges { node { availableForSale } } }
    }
  }
`;

const ARTICLE_SAMPLE_QUERY = `#graphql
  query seoStructuredDataArticle($id: ID!) {
    article(id: $id) { publishedAt }
  }
`;

async function fetchShopInfo(admin: any, fallbackShop: string): Promise<ShopInfo> {
  try {
    const res = await admin.graphql(SHOP_INFO_QUERY);
    const j: any = await res.json();
    const s = j?.data?.shop;
    return {
      name: s?.name || fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: s?.primaryDomain?.host || fallbackShop,
      // logoUrl is populated separately by fetchShopLogoUrl — see FIELD-
      // EXISTENCE NOTES above for why we can't get it from Shop.brand.
    };
  } catch {
    return {
      name: fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: fallbackShop,
    };
  }
}

// Files-search fallback: resolves a shopify://shop_images/<filename> URI to a
// CDN URL by matching the filename in the shop's Files. Kept small (first: 5)
// because we only take the first hit; the query filter narrows further.
const FILES_BY_FILENAME_QUERY = `#graphql
  query seoStructuredDataFilesByFilename($query: String!) {
    files(first: 5, query: $query) {
      edges {
        node {
          alt
          ... on MediaImage { image { url } }
        }
      }
    }
  }
`;

/**
 * Reads the Organization logo the same way the storefront's app-embed Liquid
 * block does — but from the Admin API, which does NOT expose `shop.brand`.
 * The theme's `config/settings_data.json` stores the merchant-picked header
 * logo under `current.logo` as a shopify://shop_images/<filename> URI; we
 * strip the JS-comment prefix, JSON-parse the body, and resolve the URI to
 * a CDN URL via the Files API. Returns null when no logo is set — the UI
 * then surfaces the Organization warning + a deep-link to Settings → Brand.
 */
async function fetchShopLogoUrl(admin: any): Promise<string | null> {
  try {
    const themeId = await getMainThemeId(admin);
    if (!themeId) return null;

    const raw = await readThemeFile(admin, themeId, "config/settings_data.json");
    if (!raw) return null;

    // Shopify prefixes settings_data.json with a "/* ... */" banner comment
    // that isn't valid JSON. Strip everything up to and including the first
    // `*/` before parsing; fall through cleanly if the file happens to have
    // no comment (older themes).
    const commentEnd = raw.indexOf("*/");
    const body = commentEnd > -1 ? raw.slice(commentEnd + 2) : raw;
    const settings: any = JSON.parse(body);
    const logoUri: string | undefined = settings?.current?.logo;
    if (!logoUri || typeof logoUri !== "string") return null;

    // Already a full URL (rare — some legacy themes store it that way).
    if (/^https?:\/\//i.test(logoUri)) return logoUri;

    // Normal case: shopify://shop_images/<filename>. Resolve via Files search.
    const match = logoUri.match(/^shopify:\/\/shop_images\/(.+)$/);
    if (!match) return null;
    const filename = decodeURIComponent(match[1]);

    const res = await admin.graphql(FILES_BY_FILENAME_QUERY, {
      variables: { query: `filename:${filename}` },
    });
    const j: any = await res.json();
    const edges: any[] = j?.data?.files?.edges ?? [];
    for (const e of edges) {
      const url = e?.node?.image?.url;
      if (url) return url;
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchProductPreviewData(
  admin: any,
  productId: string,
): Promise<{
  price: string | null;
  currency: string | null;
  available: boolean | null;
  imageUrl: string | null;
}> {
  try {
    const res = await admin.graphql(PRODUCT_SAMPLE_QUERY, { variables: { id: productId } });
    const j: any = await res.json();
    const p = j?.data?.product;
    const firstVariantAvailable = p?.variants?.edges?.[0]?.node?.availableForSale;
    return {
      price: p?.priceRangeV2?.minVariantPrice?.amount ?? null,
      currency: p?.priceRangeV2?.minVariantPrice?.currencyCode ?? null,
      available:
        typeof firstVariantAvailable === "boolean" ? firstVariantAvailable : null,
      imageUrl:
        p?.featuredImage?.url || p?.images?.edges?.[0]?.node?.url || null,
    };
  } catch {
    return { price: null, currency: null, available: null, imageUrl: null };
  }
}

async function fetchArticlePublishedAt(
  admin: any,
  articleId: string,
): Promise<string | null> {
  try {
    const res = await admin.graphql(ARTICLE_SAMPLE_QUERY, { variables: { id: articleId } });
    const j: any = await res.json();
    return j?.data?.article?.publishedAt ?? null;
  } catch {
    return null;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const [product, collection, article] = await Promise.all([
    db.product.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: {
        id: true,
        title: true,
        descriptionHtml: true,
        handle: true,
        seoDescription: true,
        featuredImageUrl: true,
        // Fallback: first ProductImage when featuredImageUrl is null (variant-
        // only products). Ordered by position so it matches what the theme
        // renders first.
        images: {
          select: { url: true },
          orderBy: { position: "asc" },
          take: 1,
        },
      },
    }),
    db.collection.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: { title: true, descriptionHtml: true, handle: true, seoDescription: true },
    }),
    db.article.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: { id: true, title: true, body: true, handle: true, blogTitle: true, imageUrl: true, shopifyUpdatedAt: true },
    }),
  ]);

  const [shopInfoBase, shopLogoUrl, productLive, articlePublishedAt] = await Promise.all([
    fetchShopInfo(admin, shop),
    fetchShopLogoUrl(admin),
    product ? fetchProductPreviewData(admin, product.id) : Promise.resolve(null),
    article ? fetchArticlePublishedAt(admin, article.id) : Promise.resolve(null),
  ]);
  const shopInfo: ShopInfo = { ...shopInfoBase, logoUrl: shopLogoUrl };

  const previews: PreviewBlock[] = [];

  // Organization is always previewable (built from the shop alone).
  const org = buildOrganizationJsonLd(shopInfo);
  previews.push({ labelKey: "schemaOrganization", code: renderJsonLdScript(org), warnings: validateJsonLd(org) });

  if (product) {
    const imageUrl =
      productLive?.imageUrl || product.featuredImageUrl || product.images[0]?.url || null;
    const p = buildProductJsonLd(
      {
        title: product.title,
        descriptionHtml: product.descriptionHtml,
        handle: product.handle,
        seoDescription: product.seoDescription,
        featuredImageUrl: imageUrl,
        price: productLive?.price,
        currency: productLive?.currency,
        available: productLive?.available,
      },
      shopInfo,
    );
    previews.push({ labelKey: "schemaProduct", code: renderJsonLdScript(p), warnings: validateJsonLd(p) });
  }

  if (collection) {
    const c = buildCollectionJsonLd(
      {
        title: collection.title,
        descriptionHtml: collection.descriptionHtml,
        handle: collection.handle,
        seoDescription: collection.seoDescription,
      },
      shopInfo,
    );
    previews.push({ labelKey: "schemaCollection", code: renderJsonLdScript(c), warnings: validateJsonLd(c) });
  }

  if (article) {
    const a = buildArticleJsonLd(
      {
        title: article.title,
        body: article.body,
        handle: article.handle,
        blogHandle: slugify(article.blogTitle || ""),
        imageUrl: article.imageUrl,
        publishedAt: articlePublishedAt,
        updatedAt: article.shopifyUpdatedAt,
      },
      shopInfo,
    );
    previews.push({ labelKey: "schemaArticle", code: renderJsonLdScript(a), warnings: validateJsonLd(a) });
  }

  const apiKey = process.env.SHOPIFY_API_KEY || "";
  // Activation moved to Settings → Setup: every app-owned embed is switched on
  // in ONE place, so a merchant never has to remember which feature hid its
  // activation button on which section page. No theme-editor URL is built here
  // any more — this page links to the settings tab instead.
  // Direct link to Settings → Brand where `shop.brand.logo` (the field the
  // Storefront Liquid block reads for the Organization JSON-LD logo) is set.
  // Shown next to the Organization "no logo" warning so the merchant can
  // fix it in one click.
  const brandingUrl = `https://${shop}/admin/settings/general/branding`;
  // Deep-links to the specific sample product/article the preview was built
  // from, so warning hints (missing image, no price, draft article, etc.)
  // can jump straight to the item the merchant needs to fix. Null when we
  // couldn't fetch a sample (empty catalog / no articles).
  const productAdminId = gidToNumericId(product?.id);
  const articleAdminId = gidToNumericId(article?.id);
  const sampleProductAdminUrl = productAdminId
    ? `https://${shop}/admin/products/${productAdminId}`
    : null;
  const sampleArticleAdminUrl = articleAdminId
    ? `https://${shop}/admin/articles/${articleAdminId}`
    : null;

  // Phase 5 batch audit (§7): read the last completed seoJsonLdAudit Task's
  // aggregate result + whether one is currently running, same cheap
  // existence-check pattern app.seo._index.tsx uses for its seoAudit rescan
  // button (single-flight is enforced server-side by the handler; this is
  // only so the button renders disabled/loading after a reload).
  const [lastJsonLdAuditTask, runningJsonLdAuditTask] = await Promise.all([
    db.task.findFirst({
      where: { shop, type: "seoJsonLdAudit", status: "completed" },
      orderBy: { completedAt: "desc" },
      select: { result: true, completedAt: true },
    }),
    db.task.findFirst({
      where: { shop, type: "seoJsonLdAudit", status: "running" },
      select: { id: true },
    }),
  ]);
  let jsonLdAudit: JsonLdAuditAggregate | null = null;
  if (lastJsonLdAuditTask?.result) {
    try {
      jsonLdAudit = JSON.parse(lastJsonLdAuditTask.result) as JsonLdAuditAggregate;
    } catch {
      jsonLdAudit = null;
    }
  }

  // What the storefront ACTUALLY serves, from the last crawl. Best-effort: a
  // read failure (or a snapshot older than the jsonLdTypes column) must never
  // sink this page — the in-app preview and batch report stand on their own.
  // Both halves read the SAME snapshot, deliberately in one place: two
  // separate single-flight queries would let the two reports drift apart by a
  // crawl and there is no way for a merchant to notice that from the page.
  const [liveJsonLd, liveSocial] = await Promise.all([
    summarizeLiveJsonLd(db, shop).catch(() => null),
    summarizeLiveSocial(db, shop).catch(() => null),
  ]);

  return json({
    shop,
    apiKey,
    previews,
    brandingUrl,
    sampleProductAdminUrl,
    sampleArticleAdminUrl,
    jsonLdAudit,
    jsonLdAuditRunning: !!runningJsonLdAuditTask,
    liveJsonLd,
    liveSocial,
  });
};

/** Editor list route per audited type — target of the batch-report row
 *  deep-link (`?select=<GID>`). Mirrors TYPE_PATH in app.seo._index.tsx. */
const BATCH_TYPE_PATH: Record<JsonLdAuditItemType, string> = {
  product: "/app/products",
  collection: "/app/collections",
  article: "/app/blog",
};

// Which warnings get a "fix it here" deep-link button next to them, and
// where it goes. Keys are JsonLdWarningCode values from structured-data.service;
// unmatched codes render the hint text only (no button). Kept as a plain map
// so a compile error surfaces the moment we add a warning code without
// deciding whether it deserves a button.
type FixLinkKind = "branding" | "productAdmin" | "articleAdmin" | "themeEditorJsonLd";
const FIX_LINK_BY_CODE: Record<string, FixLinkKind> = {
  orgNoLogo: "branding",
  // The social_urls setting that feeds Organization.sameAs lives on the same
  // app-embed block as JSON-LD activation, not in a dedicated admin settings
  // page — so the fix-up link reuses the JSON-LD theme-editor deep-link.
  orgNoSameAs: "themeEditorJsonLd",
  productMissingName: "productAdmin",
  productNoImage: "productAdmin",
  productNoDescription: "productAdmin",
  productNoOffer: "productAdmin",
  offerNoAvailability: "productAdmin",
  productNoGtinMpn: "productAdmin",
  articleMissingHeadline: "articleAdmin",
  articleNoImage: "articleAdmin",
  articleNoDatePublished: "articleAdmin",
};

export default function SeoStructuredData() {
  const {
    shop,
    apiKey,
    previews,
    brandingUrl,
    sampleProductAdminUrl,
    sampleArticleAdminUrl,
    jsonLdAudit,
    jsonLdAuditRunning,
    liveJsonLd,
    liveSocial,
  } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const s = t.seo.structuredDataPage;
  const b = (s as any).batch as Record<string, string>;
  const warningCopy = (s as any).warnings as Record<string, string>;
  const live = (s as any).live as Record<string, string>;
  const soc = (s as any).social as Record<string, any>;

  /** Every app embed is activated in Settings → Setup, not from here. */
  // Straight to the switch, not to Settings. The activation card is where the
  // decision is made, and a merchant who just read "do not switch this on"
  // should not have to find the embed on another page first. The deep link
  // must use the app's api_key (Shopify client_id), NOT the extension UID:
  // the uuid form is deprecated and answers "app embed doesn't exist".
  const buildEmbedUrl = (blockHandle: string) =>
    `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/${blockHandle}`;
  const jsonLdEmbedUrl = buildEmbedUrl("structured-data");
  const socialEmbedUrl = buildEmbedUrl("social-meta");

  // Delivery before data quality before activation. The section used to open
  // with the activation buttons and put the measurement below them — i.e. in
  // the order in which the merchant makes the mistake before they can see it,
  // which is how a live shop ended up serving its product schema twice
  // (PLAN_MARKUP_ACTIVATION §0.4). Switching a type on is now step 3 and reads
  // step 1's numbers.
  const [step, setStep] = useState<"delivery" | "data" | "activate">("delivery");

  // Each tile carries its own verdict. "Unknown" is a real state for all three
  // and must not be dressed up as a clean result: no crawl yet on the left,
  // never run in the middle, nothing measured to gate against on the right.
  //
  // Step 1 now covers BOTH markup families, so its badge is the worse of the
  // two. A shop with clean JSON-LD and two og:image tags on every page is not
  // a "complete" delivery, and one badge that only looked at half of it would
  // be the same "measure after you act" mistake one level down.
  const jsonLdKnown = !!liveJsonLd && !liveJsonLd.notMeasured;
  const socialKnown = !!liveSocial && !liveSocial.notMeasured;
  const anyDeliveryDuplicates =
    (jsonLdKnown && liveJsonLd!.duplicates.length > 0) ||
    (socialKnown && liveSocial!.duplicates.length > 0);
  const anyDeliveryGaps =
    (jsonLdKnown && liveJsonLd!.coverage.some((c) => c.withMarkup < c.total)) ||
    (socialKnown &&
      liveSocial!.coverage.some((c) => c.withTitle < c.total || c.withImage < c.total));
  // "What exactly is missing", in the numbers the summary lines print. Built
  // per page KIND, because "12 pages without markup" is unactionable next to
  // "12 of 41 product pages" — the merchant fixes a page kind, not a total.
  const jsonLdMissing = {
    total: (liveJsonLd?.coverage ?? []).reduce((n, c) => n + (c.total - c.withMarkup), 0),
    parts: (liveJsonLd?.coverage ?? [])
      .filter((c) => c.withMarkup < c.total)
      .map(
        (c) =>
          `${(live.pageTypes as unknown as Record<string, string>)[c.resourceType] || c.resourceType}: ${c.total - c.withMarkup}/${c.total}`,
      ),
  };
  // The social half names the TAG, not the page kind: og:image missing on 40
  // pages is one fix (the block's default share image), wherever they sit.
  const socialMissing = {
    parts: [
      ...((liveSocial?.coverage ?? []).reduce((n, c) => n + (c.total - c.withTitle), 0) > 0
        ? [
            `og:title: ${(liveSocial?.coverage ?? []).reduce((n, c) => n + (c.total - c.withTitle), 0)}`,
          ]
        : []),
      ...((liveSocial?.coverage ?? []).reduce((n, c) => n + (c.total - c.withImage), 0) > 0
        ? [
            `og:image: ${(liveSocial?.coverage ?? []).reduce((n, c) => n + (c.total - c.withImage), 0)}`,
          ]
        : []),
    ],
  };

  const deliveryBadge = !jsonLdKnown && !socialKnown ? (
    <Badge>{live.badgeUnknown}</Badge>
  ) : anyDeliveryDuplicates ? (
    <Badge tone="critical">{live.badgeDuplicates}</Badge>
  ) : anyDeliveryGaps ? (
    <Badge tone="warning">{live.badgeGaps}</Badge>
  ) : !jsonLdKnown || !socialKnown ? (
    // One measured half and one unmeasured half is never "complete" — the
    // unmeasured half is exactly where an unnoticed duplicate would sit — but
    // it is not "Gaps" either. The og:* columns ship with this version, so
    // EVERY existing shop has an unmeasured social half until it re-crawls;
    // labelling that "your pages are missing markup" would put a false finding
    // on the most visible badge of the page.
    <Badge tone="attention">{live.badgePartlyMeasured}</Badge>
  ) : (
    <Badge tone="success">{live.badgeOk}</Badge>
  );

  const dataBadge = !jsonLdAudit ? (
    <Badge>{b.badgeUnknown}</Badge>
  ) : jsonLdAudit.buckets.length === 0 ? (
    <Badge tone="success">{b.badgeOk}</Badge>
  ) : (
    <Badge tone="warning">
      {b.badgeIssues.replace("{count}", String(jsonLdAudit.buckets.length))}
    </Badge>
  );
  const hintCopy = (s as any).hints as Record<string, string>;
  // The raw severity ("error" | "warning" | "info") used to be printed into
  // the badge untranslated — English words in a German and a Spanish UI.
  const severityCopy = (s as any).severityLabels as Record<string, string> | undefined;
  const act = (s as any).activation as Record<string, any>;
  const gv = (s as any).galleryVideos as Record<string, string>;
  /**
   * The sweep that rode along on the batch check — see JsonLdAuditAggregate.
   * `undefined` (never checked, or a task result from before it existed) and
   * `null` (the sweep ran and was refused) are kept APART on purpose: the first
   * is answered by pressing the button, the second is not, and a shop whose
   * sweep throttles every time would otherwise see the pre-feature page forever
   * with the failure only in a log line.
   */
  const galleryVideos = jsonLdAudit ? jsonLdAudit.galleryVideos : undefined;

  // §1.2 — the gate. `measured` is deliberately strict: no crawl at all AND a
  // snapshot whose jsonLdTypes column is empty everywhere both count as "not
  // measured", which yields grey, never green. `originKnown` is the weaker
  // second flag — only a crawl that saw our marker somewhere can read
  // "appPages === 0" as "none of these are ours".
  const jsonLdMeasured = jsonLdKnown;
  const jsonLdOriginKnown = liveJsonLd?.appEmbedDetected === true;
  const switchGates = JSON_LD_SWITCHES.map((sw) => ({
    ...sw,
    // Scoped, never shop-wide: our block emits FAQPage on PRODUCT pages only,
    // so a theme's FAQPage on /pages/faq must not be read as a collision.
    gate: activationGate(statForSwitch(liveJsonLd?.typeStats, sw.type, sw.scopes), {
      measured: jsonLdMeasured,
      originKnown: jsonLdOriginKnown,
      // "No bucket" is ambiguous — it is what an untouched page kind and an
      // UNCRAWLED one look like alike. A switch is only judged where the crawl
      // actually saw at least one page of its scope.
      //
      // `scopes: null` means SHOP-WIDE (Organization sits on every page), and
      // `null ?? []` turned that into an empty list whose `.some()` is always
      // false — so Organization reported "not measured" after every crawl, for
      // good. A shop-wide switch is covered as soon as ANY page was judged.
      scopeCovered: scopeCovered(sw.scopes, liveJsonLd?.scopePages, liveJsonLd?.pagesChecked ?? 0),
    }),
  }));

  // The social block has ONE switch in the theme editor but nine tags behind
  // it, and a theme that sets og:title while leaving twitter:* alone is the
  // normal case — so each tag is gated separately and the embed's verdict is
  // the worst of them.
  const socialMeasured = socialKnown;
  const socialOriginKnown = liveSocial?.appEmbedDetected === true;
  const socialGates = APP_SOCIAL_TAGS.map((tag) => ({
    tag,
    // The social block has no page-type guard, so its stats are already
    // shop-wide and there is nothing to scope.
    gate: activationGate(statForSwitch(liveSocial?.typeStats, tag, null), {
      measured: socialMeasured,
      originKnown: socialOriginKnown,
    }),
  }));

  // One verdict for the tile, over both embeds. Worst wins, and "not measured"
  // is its own rung rather than the best of the set — the whole point is that
  // an unmeasured shop gets no green light, and that a measured conflict in
  // one family is not softened by the other family being fine.
  const jsonLdWorst = worstActivationVerdict(switchGates.map((g) => g.gate.verdict));
  // Card badges answer "can I switch this EMBED on", not "how bad is the worst
  // type" — see embedBadgeVerdict. The tile badge below keeps the severity roll-up.
  const jsonLdBadge = embedBadgeVerdict(switchGates.map((g) => g.gate.verdict));
  const socialWorst = worstActivationVerdict(socialGates.map((g) => g.gate.verdict));
  const socialBadge = embedBadgeVerdict(socialGates.map((g) => g.gate.verdict));
  const activationWorst = worstActivationVerdict([jsonLdWorst, socialWorst]);
  const activationBadge =
    activationWorst === "unknown" ? (
      <Badge>{act.badgeUnknown as string}</Badge>
    ) : activationWorst === "duplicateApp" || activationWorst === "duplicateForeign" ? (
      <Badge tone="critical">{act.badgeConflict as string}</Badge>
    ) : activationWorst === "foreignOnly" || activationWorst === "mixed" ? (
      <Badge tone="warning">{act.badgeReview as string}</Badge>
    ) : activationWorst === "originUnknown" || activationWorst === "repeatableUnjudged" ? (
      <Badge tone="info">{act.badgePartial as string}</Badge>
    ) : (
      <Badge tone="success">{act.badgeReady as string}</Badge>
    );

  /**
   * One switch, one line. Shared by the seven JSON-LD switches and the nine
   * social tags — they differ only in what "the switch" is called, and giving
   * them two renderers is how the two halves would drift apart.
   *
   * Deliberately ONE sentence per row. The first cut spent three on each, so a
   * section was twenty sentences of prose in which the one switch that needed
   * action was indistinguishable from the six that did not. The bold lead-in IS
   * the instruction; the rest is the evidence for it.
   */
  const renderGateRow = ({
    key,
    label,
    settingId,
    gate,
    defaultOn,
    examples,
  }: {
    key: string;
    label: string;
    /** The `block.settings.*` id, or the tag's namespace — shown verbatim so the
     *  merchant can find the same string in the theme editor / page source. */
    settingId: string;
    gate: ReturnType<typeof activationGate>;
    /** Undefined where the switch has no per-item default (the social tags all
     *  ride on one embed toggle). */
    defaultOn?: boolean;
    examples: string[];
  }) => {
    const showExamples = gate.verdict === "duplicateApp" || gate.verdict === "duplicateForeign";
    return (
      <Box key={key} padding="200" borderBlockStartWidth="025" borderColor="border">
        <BlockStack gap="050">
          <InlineStack gap="200" blockAlign="center" wrap>
            <Badge tone={activationTone(gate.verdict)}>
              {(act.verdictLabels as Record<string, string>)[gate.verdict]}
            </Badge>
            <Text as="span" variant="bodyMd" fontWeight="semibold">{label}</Text>
            <Text as="span" variant="bodySm" tone="subdued">
              {defaultOn === undefined
                ? settingId
                : `${settingId} · ${defaultOn ? (act.defaultOn as string) : (act.defaultOff as string)}`}
            </Text>
          </InlineStack>
          <Text as="p" variant="bodySm">{emphasize(verdictText(gate.verdict, gate))}</Text>
          {/* Several VideoObjects on one page are three product videos, not a
              collision — the duplicate rule is off for those types, so a clean
              result there means "not checked", never "checked and fine". */}
          {gate.repeatable && gate.pages > 0 && (
            <Text as="p" variant="bodySm" tone="subdued">{act.repeatableCaveat as string}</Text>
          )}
          {showExamples &&
            examples.slice(0, 3).map((u) => (
              <Text as="p" variant="bodySm" tone="subdued" key={u}>{u}</Text>
            ))}
        </BlockStack>
      </Box>
    );
  };

  /**
   * The section's bottom line, above its switches: what to do, in one bolded
   * phrase, with the affected switches named. Merchants act on this line; the
   * rows below it are the evidence.
   */
  const renderVerdictSummary = (
    gates: { label: string; verdict: ActivationVerdict }[],
    measured: boolean,
  ) => {
    if (!measured) return null;
    const groups = groupGatesByAction(gates);
    const lead = groups[0];
    if (!lead) return null;
    const summary = act.summary as Record<string, string>;
    return (
      <Banner tone={actionTone(lead.action)}>
        <BlockStack gap="100">
          <Text as="p" variant="bodyMd" fontWeight="semibold">
            {(summary[lead.action] || "")
              .replace("{count}", String(lead.labels.length))
              .replace("{names}", lead.labels.join(", "))}
          </Text>
          {groups.length > 1 && (
            <Text as="p" variant="bodySm">
              {groups
                .slice(1)
                .map((g) =>
                  (summary[`${g.action}Short`] || "").replace("{count}", String(g.labels.length)),
                )
                .filter(Boolean)
                .join(" · ")}
            </Text>
          )}
        </BlockStack>
      </Banner>
    );
  };

  /**
   * Step 1's bottom line, per half. The tile badge said "Lücken" while the card
   * below it only showed a table — a merchant reading "gaps" has to be told
   * WHICH, in numbers, in the first line of the card. Duplicates outrank gaps:
   * markup served twice is a defect, markup missing is an omission.
   */
  const renderDeliverySummary = (
    parts: { tone: "critical" | "warning" | "success"; text: string }[],
  ) => {
    const lead = parts.find((p) => p.tone === "critical") ?? parts.find((p) => p.tone === "warning") ?? parts[0];
    if (!lead) return null;
    return (
      <Banner tone={lead.tone}>
        <BlockStack gap="050">
          {parts.map((p) => (
            <Text
              key={p.text}
              as="p"
              variant="bodyMd"
              fontWeight={p === lead ? "semibold" : "regular"}
            >
              {p.text}
            </Text>
          ))}
        </BlockStack>
      </Banner>
    );
  };

  /** Verdict copy, with the measured numbers substituted in. */
  const verdictText = (verdict: ActivationVerdict, g: { pages: number; appPages: number; duplicatePages: number; appIsOneCopy: number }) =>
    ((act.verdicts as Record<string, string>)[verdict] || "")
      .replace("{pages}", String(g.pages))
      .replace("{appPages}", String(g.appPages))
      .replace("{duplicatePages}", String(g.duplicatePages))
      .replace("{appIsOneCopy}", String(g.appIsOneCopy));

  const schemaTypeKeys = [
    "schemaProduct",
    "schemaCollection",
    "schemaArticle",
    "schemaOrganization",
    "schemaBreadcrumb",
    "schemaVideo",
  ];

  const fixUrlFor = (kind: FixLinkKind): string | null => {
    if (kind === "branding") return brandingUrl;
    if (kind === "productAdmin") return sampleProductAdminUrl;
    if (kind === "articleAdmin") return sampleArticleAdminUrl;
    // themeEditorJsonLd is handled as an in-app navigation, not a URL.
    return null;
  };
  const fixLabelFor = (kind: FixLinkKind): string => {
    if (kind === "branding") return s.setBrandLogo;
    if (kind === "productAdmin") return (s as any).openSampleProduct as string;
    if (kind === "articleAdmin") return (s as any).openSampleArticle as string;
    if (kind === "themeEditorJsonLd") return (s as any).activateInSettings as string;
    return "";
  };

  const severityTone = (severity: string): "critical" | "info" | "warning" =>
    severity === "error" ? "critical" : severity === "info" ? "info" : "warning";

  // "Jetzt prüfen" — kicks off the detached "seoJsonLdAudit" Task
  // (seo-json-ld-audit.handler.ts) through the same shared /api/ai route
  // every other non-AI SEO scan uses (mirrors handleRescan in
  // app.seo._index.tsx). contentType is an unused-but-valid placeholder to
  // satisfy /api/ai's generic contentType gate — the handler itself is a
  // non-AI, shop-wide action (see NON_AI_ACTIONS in api.ai.tsx).
  const checkFetcher = useFetcher<{ success: boolean; error?: string; taskId?: string }>();
  const [checkStarted, setCheckStarted] = useState(false);
  const [checkBanner, setCheckBanner] = useState<{ tone: "critical"; message: string } | null>(null);
  const checkStartedAtRef = useRef(0);

  useEffect(() => {
    if (checkFetcher.state !== "idle" || !checkFetcher.data) return;
    if (checkFetcher.data.success) {
      checkStartedAtRef.current = Date.now();
      setCheckStarted(true);
    } else {
      setCheckBanner({ tone: "critical", message: checkFetcher.data.error || b.checkStartError });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkFetcher.state, checkFetcher.data]);

  const checkInProgress = jsonLdAuditRunning || checkStarted;

  const handleCheckNow = () => {
    if (checkInProgress || checkFetcher.state !== "idle") return;
    setCheckBanner(null);
    const formData = new FormData();
    formData.append("action", "seoJsonLdAudit");
    formData.append("contentType", "products");
    checkFetcher.submit(formData, { method: "post", action: "/api/ai" });
  };

  // Poll the loader while a check is running, same pattern as the SEO
  // dashboard's rescan poller.
  const revalidator = useRevalidator();
  const revalidatorRef = useRef(revalidator);
  revalidatorRef.current = revalidator;

  useEffect(() => {
    if (!checkInProgress) return;
    const interval = setInterval(() => {
      revalidatorRef.current.revalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [checkInProgress]);

  useEffect(() => {
    if (!checkStarted || jsonLdAuditRunning) return;
    if (Date.now() - checkStartedAtRef.current > 5000) setCheckStarted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jsonLdAuditRunning, checkStarted, jsonLdAudit]);

  const openBatchItemInEditor = (type: JsonLdAuditItemType, id: string) => {
    handleNavigate(BATCH_TYPE_PATH[type], { searchParams: new URLSearchParams({ select: id }) });
  };

  return (
    <SeoSectionLayout sectionId="structuredData">
      <BlockStack gap="400">
        {/* 1. What are structured data + why care */}
        <SeoHelpBanner title={(s as any).introTitle as string}>
          <BlockStack gap="200">
            <Text as="p" variant="bodyMd">{(s as any).introBody1 as string}</Text>
            <Text as="p" variant="bodyMd">{(s as any).introBody2 as string}</Text>
            <Text as="p" variant="bodyMd">{(s as any).introBody3 as string}</Text>
          </BlockStack>
        </SeoHelpBanner>

        {/* The three halves are sequential, not a set of equal cards — markup
            has to reach the page before its data quality means anything, and
            switching a type ON is only decidable once you know what the page
            already serves. Activation used to sit at the TOP of this page,
            above its own measurement; that is how a live shop came to serve two
            Product nodes with an identical @id (PLAN_MARKUP_ACTIVATION §0.4).
            Same shape the AEO section uses for its three steps. */}
        <InlineGrid columns={{ xs: 1, sm: 3 }} gap="300">
          <StepTile
            selected={step === "delivery"}
            onSelect={() => setStep("delivery")}
            kicker={live.stepKicker}
            title={live.stepTitle}
            body={live.stepBody}
            badge={deliveryBadge}
          />
          <StepTile
            selected={step === "data"}
            onSelect={() => setStep("data")}
            kicker={b.stepKicker}
            title={b.stepTitle}
            body={b.stepBody}
            badge={dataBadge}
          />
          <StepTile
            selected={step === "activate"}
            onSelect={() => setStep("activate")}
            kicker={act.stepKicker as string}
            title={act.stepTitle as string}
            body={act.stepBody as string}
            badge={activationBadge}
          />
        </InlineGrid>

        {/* Step 1 — what the storefront actually serves (from the last crawl).
            The only place in the app that reads a real page. Both markup
            families are read off the SAME snapshot: JSON-LD for Google, Open
            Graph / Twitter for the link previews, and each half answers the
            same two questions — is it delivered, and is it delivered twice. */}
        {step === "delivery" && (
          <BlockStack gap="400">
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{live.title}</Text>
              <Text as="p" variant="bodyMd" tone="subdued">{live.intro}</Text>

              {!liveJsonLd ? (
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{live.noCrawl}</Text>
                    <div>
                      <Button onClick={() => handleNavigate("/app/seo/crawl")}>{live.goToCrawl}</Button>
                    </div>
                  </BlockStack>
                </Banner>
              ) : liveJsonLd.notMeasured ? (
                // An older snapshot has no jsonLdTypes at all. Reporting that as
                // "no structured data anywhere" would be a false alarm.
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{live.notMeasured}</Text>
                    <div>
                      <Button onClick={() => handleNavigate("/app/seo/crawl")}>{live.goToCrawl}</Button>
                    </div>
                  </BlockStack>
                </Banner>
              ) : (
                <BlockStack gap="300">
                  {/* The bottom line first, in numbers. The tile badge used to
                      say "Lücken" while the card below only offered a table to
                      derive them from. */}
                  {renderDeliverySummary([
                    ...(liveJsonLd.duplicates.length > 0
                      ? [{
                          tone: "critical" as const,
                          text: (live.sumDuplicates as string)
                            .replace("{count}", String(liveJsonLd.duplicates.length))
                            .replace(
                              "{names}",
                              liveJsonLd.duplicates
                                .map((d) => `${d.type} (${d.pages})`)
                                .join(", "),
                            ),
                        }]
                      : []),
                    ...(jsonLdMissing.total > 0
                      ? [{
                          tone: "warning" as const,
                          text: (live.sumGaps as string)
                            .replace("{count}", String(jsonLdMissing.total))
                            .replace("{names}", jsonLdMissing.parts.join(", ")),
                        }]
                      : []),
                    ...(liveJsonLd.duplicates.length === 0 && jsonLdMissing.total === 0
                      ? [{ tone: "success" as const, text: live.sumClean as string }]
                      : []),
                  ])}
                  <Text as="p" variant="bodySm" tone="subdued">
                    {live.basis
                      .replace("{time}", new Date(liveJsonLd.crawledAt).toLocaleString())
                      .replace("{pages}", String(liveJsonLd.pagesChecked))}
                  </Text>
                  {liveJsonLd.crawlStatus === "capped" && (
                    <Banner tone="warning">{live.cappedCrawl}</Banner>
                  )}

                  {liveJsonLd.coverage.length > 0 && (
                    <DataTable
                      columnContentTypes={["text", "numeric", "numeric", "text"]}
                      headings={[
                        live.colPageType,
                        live.colCrawled,
                        live.colCoverage,
                        live.colMissingExamples,
                      ]}
                      rows={liveJsonLd.coverage.map((row) => [
                        (live.pageTypes as unknown as Record<string, string>)[row.resourceType] ||
                          row.resourceType,
                        // Crawled vs. catalog — a partial crawl must not read
                        // like a complete result.
                        row.catalogTotal > row.total ? (
                          <Text as="span" variant="bodySm" tone="caution">
                            {`${row.total} / ${row.catalogTotal}`}
                          </Text>
                        ) : (
                          `${row.total} / ${row.catalogTotal || row.total}`
                        ),
                        `${row.withMarkup} / ${row.total}`,
                        row.withMarkup === row.total ? (
                          <Badge tone="success">{live.allCovered}</Badge>
                        ) : (
                          <BlockStack gap="050">
                            {row.missingExamples.map((u) => (
                              <Text as="span" variant="bodySm" tone="subdued" key={u}>{u}</Text>
                            ))}
                          </BlockStack>
                        ),
                      ])}
                    />
                  )}

                  {liveJsonLd.duplicates.length > 0 && (
                    <Banner tone="warning">
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd">{live.duplicatesHint}</Text>
                        {liveJsonLd.duplicates.map((dup) => (
                          <BlockStack gap="050" key={dup.type}>
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {live.duplicateRow
                                .replace("{type}", dup.type)
                                .replace("{pages}", String(dup.pages))}
                            </Text>
                            {/* The actionable half: turning our own toggle off
                                only helps where one copy is actually ours. */}
                            <Text as="p" variant="bodySm">
                              {dup.appIsOneCopy > 0
                                ? live.duplicateFromApp.replace("{pages}", String(dup.appIsOneCopy))
                                : liveJsonLd.appEmbedDetected
                                  ? live.duplicateNotFromApp
                                  : live.duplicateSourceUnknown}
                            </Text>
                            {dup.examples.map((u) => (
                              <Text as="p" variant="bodySm" tone="subdued" key={u}>{u}</Text>
                            ))}
                          </BlockStack>
                        ))}
                      </BlockStack>
                    </Banner>
                  )}

                  <Text as="p" variant="bodySm">
                    {liveJsonLd.appEmbedDetected
                      ? live.appEmbedOn
                      : live.appEmbedUnknown}
                  </Text>

                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">{live.typesFound}</Text>
                    {liveJsonLd.typeCounts.length === 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">{live.noTypes}</Text>
                    ) : (
                      <InlineStack gap="200" wrap>
                        {liveJsonLd.typeCounts.map((tc) => (
                          <Badge key={tc.type}>
                            {live.typeCount.replace("{type}", tc.type).replace("{pages}", String(tc.pages))}
                          </Badge>
                        ))}
                      </InlineStack>
                    )}
                  </BlockStack>

                  <Text as="p" variant="bodySm" tone="subdued">{live.sourceCaveat}</Text>
                </BlockStack>
              )}
            </BlockStack>
          </Card>

          {/* The social half. Same snapshot, same two questions — most themes
              set og:title and og:image themselves, and two og:image tags on one
              page are for Facebook and LinkedIn what two Product nodes are for
              Google: the scraper picks one, and not the merchant. */}
          <Card>
            <BlockStack gap="300">
              <Text as="h3" variant="headingMd">{soc.title as string}</Text>
              <Text as="p" variant="bodyMd" tone="subdued">{soc.intro as string}</Text>

              {!liveSocial ? (
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{live.noCrawl}</Text>
                    <div>
                      <Button onClick={() => handleNavigate("/app/seo/crawl")}>{live.goToCrawl}</Button>
                    </div>
                  </BlockStack>
                </Banner>
              ) : liveSocial.notMeasured ? (
                // A snapshot from before the og:* columns existed. Reporting it
                // as "no social markup anywhere" would be a false alarm — the
                // same trap the JSON-LD half already guards against.
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodyMd">{soc.notMeasured as string}</Text>
                    <div>
                      <Button onClick={() => handleNavigate("/app/seo/crawl")}>{live.goToCrawl}</Button>
                    </div>
                  </BlockStack>
                </Banner>
              ) : (
                <BlockStack gap="300">
                  {renderDeliverySummary([
                    ...(liveSocial.duplicates.length > 0
                      ? [{
                          tone: "critical" as const,
                          text: (soc.sumDuplicates as string)
                            .replace("{count}", String(liveSocial.duplicates.length))
                            .replace(
                              "{names}",
                              liveSocial.duplicates.map((d) => `${d.tag} (${d.pages})`).join(", "),
                            ),
                        }]
                      : []),
                    ...(socialMissing.parts.length > 0
                      ? [{
                          tone: "warning" as const,
                          text: (soc.sumGaps as string).replace(
                            "{names}",
                            socialMissing.parts.join(", "),
                          ),
                        }]
                      : []),
                    ...(liveSocial.duplicates.length === 0 && socialMissing.parts.length === 0
                      ? [{ tone: "success" as const, text: soc.sumClean as string }]
                      : []),
                  ])}
                  <Text as="p" variant="bodySm" tone="subdued">
                    {live.basis
                      .replace("{time}", new Date(liveSocial.crawledAt).toLocaleString())
                      .replace("{pages}", String(liveSocial.pagesChecked))}
                  </Text>

                  {liveSocial.coverage.length > 0 && (
                    <DataTable
                      columnContentTypes={["text", "numeric", "numeric", "numeric", "text"]}
                      headings={[
                        live.colPageType,
                        live.colCrawled,
                        soc.colTitle as string,
                        soc.colImage as string,
                        soc.colMissingExamples as string,
                      ]}
                      rows={liveSocial.coverage.map((row) => [
                        (soc.pageTypes as Record<string, string>)[row.resourceType] ||
                          row.resourceType,
                        String(row.total),
                        `${row.withTitle} / ${row.total}`,
                        `${row.withImage} / ${row.total}`,
                        row.missingExamples.length === 0 ? (
                          <Badge tone="success">{live.allCovered}</Badge>
                        ) : (
                          <BlockStack gap="050">
                            {row.missingExamples.map((u) => (
                              <Text as="span" variant="bodySm" tone="subdued" key={u}>{u}</Text>
                            ))}
                          </BlockStack>
                        ),
                      ])}
                    />
                  )}

                  {liveSocial.duplicates.length > 0 && (
                    <Banner tone="warning">
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd">{soc.duplicatesHint as string}</Text>
                        {liveSocial.duplicates.map((dup) => (
                          <BlockStack gap="050" key={dup.tag}>
                            <Text as="p" variant="bodySm" fontWeight="semibold">
                              {(soc.duplicateRow as string)
                                .replace("{tag}", dup.tag)
                                .replace("{pages}", String(dup.pages))}
                            </Text>
                            {/* Same rule as the JSON-LD half: switching our own
                                embed off only helps where one copy is ours. */}
                            <Text as="p" variant="bodySm">
                              {dup.appIsOneCopy > 0
                                ? (soc.duplicateFromApp as string).replace(
                                    "{pages}",
                                    String(dup.appIsOneCopy),
                                  )
                                : liveSocial.appEmbedDetected
                                  ? (soc.duplicateNotFromApp as string)
                                  : (soc.duplicateSourceUnknown as string)}
                            </Text>
                            {dup.examples.map((u) => (
                              <Text as="p" variant="bodySm" tone="subdued" key={u}>{u}</Text>
                            ))}
                          </BlockStack>
                        ))}
                      </BlockStack>
                    </Banner>
                  )}

                  <Text as="p" variant="bodySm">
                    {liveSocial.appEmbedDetected
                      ? (soc.appEmbedOn as string)
                      : (soc.appEmbedUnknown as string)}
                  </Text>

                  <BlockStack gap="100">
                    <Text as="p" variant="bodySm" fontWeight="semibold">{soc.tagsFound as string}</Text>
                    {liveSocial.tagCounts.length === 0 ? (
                      <Text as="p" variant="bodySm" tone="subdued">{soc.noTags as string}</Text>
                    ) : (
                      <InlineStack gap="200" wrap>
                        {liveSocial.tagCounts.map((tc) => (
                          <Badge key={tc.tag}>
                            {live.typeCount.replace("{type}", tc.tag).replace("{pages}", String(tc.pages))}
                          </Badge>
                        ))}
                      </InlineStack>
                    )}
                  </BlockStack>
                </BlockStack>
              )}
            </BlockStack>
          </Card>
          </BlockStack>
        )}

        {/* Step 2 — whether the CATALOG carries the data a rich result needs.
            The JSON-LD half reads the DB cache; the gallery-video half of the
            same batch check is a bounded live Admin sweep, because the two
            metafields it needs are mirrored nowhere. Neither reads a live PAGE
            — that is step 1's job. */}
        {step === "data" && (
          <BlockStack gap="400">
          {/* 3. What you see below (preview intro + schema types) */}
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingLg">
                {(s as any).previewIntroTitle as string}
              </Text>
              <Text as="p" variant="bodyMd" tone="subdued">
                {(s as any).previewIntroBody as string}
              </Text>
              <BlockStack gap="100">
                <Text as="h3" variant="headingMd">
                  {s.schemaTypesTitle}
                </Text>
                <InlineStack gap="200" wrap>
                  {schemaTypeKeys.map((k) => (
                    <Badge key={k} tone="success">
                      {(s as unknown as Record<string, string>)[k]}
                    </Badge>
                  ))}
                </InlineStack>
                {/* One box for the three things that are BACKGROUND rather
                    than action: what the preview below cannot show, why a
                    gallery video needs a date, and what FAQ waits for.
                    They stood as three loose subdued lines in three places
                    and were read as footnotes — a merchant skipped exactly
                    the sentence that explains a missing preview entry. The
                    gallery RESULT stays outside: a finding a merchant has to
                    act on must not sit in the same grey box as the reasons. */}
                <Banner tone="info">
                  <BlockStack gap="200">
                    <Text as="p" variant="bodySm">
                      {emphasize((s as any).schemaVideoNote as string)}
                    </Text>
                    <Text as="p" variant="bodySm">
                      {emphasize((s as any).schemaVideoDateNote as string)}
                    </Text>
                    <Text as="p" variant="bodySm">
                      {emphasize((s as any).schemaFaqNote as string)}
                    </Text>
                  </BlockStack>
                </Banner>
                {/* The RESULT of the sweep, in three states that must not be
                    confused: it never ran or was refused, it ran and found
                    none, or it found some and names them. Why a date can be
                    missing at all is explained once, in the box above. */}
                {/* `null` means the sweep RAN and was refused — a state the
                    button cannot fix by being pressed again, so it must not
                    look like "never checked". `undefined` is a result from
                    before the sweep existed and says nothing at all, so it
                    prints nothing: the reason why a date can be missing is
                    already in the box above. */}
                {!galleryVideos ? (
                  galleryVideos === null ? (
                    <Text as="p" variant="bodySm" tone="subdued">{gv.failed as string}</Text>
                  ) : null
                ) : galleryVideos.totalProducts === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {(gv.none as string).replace(
                      "{variants}",
                      String(galleryVideos.scannedVariants),
                    )}
                    {/* A sweep that broke off part-way found nothing SO FAR —
                        which is not the same as nothing being there. */}
                    {galleryVideos.capped ? ` ${gv.capped as string}` : ""}
                  </Text>
                ) : (
                  <Banner tone={galleryVideos.missingDate > 0 || (galleryVideos.mediaMissingDate ?? 0) > 0 ? "warning" : "info"}>
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd" fontWeight="semibold">
                        {(gv.found as string)
                          .replace("{products}", String(galleryVideos.totalProducts))
                          .replace("{missing}", String(galleryVideos.missingDate))}
                      </Text>
                      {galleryVideos.missingDate > 0 && (
                        <Text as="p" variant="bodySm">{emphasize(gv.fix as string)}</Text>
                      )}
                      {/* The other half, and a different remedy: a video in the
                          product's OWN media gets its date from the sync, so a
                          resync fixes it and nobody has to type one. Counted
                          and phrased separately for exactly that reason —
                          `?? 0` keeps a task result from before this existed
                          silent instead of reporting a confident zero. */}
                      {(galleryVideos.mediaMissingDate ?? 0) > 0 && (
                        <Text as="p" variant="bodySm">
                          {emphasize(
                            (gv.mediaMissing as string).replace(
                              "{count}",
                              String(galleryVideos.mediaMissingDate),
                            ),
                          )}
                        </Text>
                      )}
                      {/* A Vimeo gallery video produces no markup at all, so a
                          date would not help it — said whenever one is present,
                          not only when a product has nothing else, or a product
                          with one YouTube and one Vimeo video reads as fine. */}
                      {galleryVideos.withVimeo > 0 && (
                        <Text as="p" variant="bodySm">
                          {(gv.vimeo as string).replace(
                            "{count}",
                            String(galleryVideos.withVimeo),
                          )}
                        </Text>
                      )}
                      {galleryVideos.capped && (
                        <Text as="p" variant="bodySm" tone="subdued">{gv.capped as string}</Text>
                      )}
                      <BlockStack gap="050">
                        {galleryVideos.products.map((prod) => (
                          <InlineStack key={prod.id} gap="200" blockAlign="center" wrap>
                            <Button
                              variant="plain"
                              onClick={() => openBatchItemInEditor("product", prod.id)}
                            >
                              {prod.title}
                            </Button>
                            <Text as="span" variant="bodySm" tone="subdued">
                              {(prod.hasUploadDate ? (gv.rowOk as string) : (gv.rowMissing as string))
                                .replace("{youtube}", String(prod.youtube))
                                .replace("{vimeo}", String(prod.vimeo))}
                              {(prod.mediaMissingDate ?? 0) > 0
                                ? ` · ${(gv.rowMedia as string).replace("{count}", String(prod.mediaMissingDate))}`
                                : ""}
                            </Text>
                          </InlineStack>
                        ))}
                        {galleryVideos.totalProducts > galleryVideos.products.length && (
                          <Text as="span" variant="bodySm" tone="subdued">
                            {b.moreItems.replace(
                              "{count}",
                              String(galleryVideos.totalProducts - galleryVideos.products.length),
                            )}
                          </Text>
                        )}
                      </BlockStack>
                      {/* A merchant who fixed the products and did not re-run
                          the check would otherwise read a stale list as current. */}
                      <Text as="p" variant="bodySm" tone="subdued">
                        {b.lastChecked.replace(
                          "{time}",
                          new Date(galleryVideos.generatedAt).toLocaleString(),
                        )}
                      </Text>
                    </BlockStack>
                  </Banner>
                )}
              </BlockStack>
            </BlockStack>
          </Card>

          {/* 4. Live preview with per-warning hints + fix-up buttons */}
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  {s.previewTitle}
                </Text>
                <Button url={GOOGLE_RICH_RESULTS_TEST} target="_blank" variant="plain">
                  {s.validateWithGoogle}
                </Button>
              </InlineStack>

              {previews.length === 0 ? (
                <Text as="p" tone="subdued">
                  {s.previewEmpty}
                </Text>
              ) : (
                previews.map((block) => (
                  <BlockStack key={block.labelKey} gap="200">
                    <Text as="p" variant="headingSm">
                      {(s as unknown as Record<string, string>)[block.labelKey]}
                    </Text>
                    {block.warnings.length === 0 ? (
                      <Badge tone="success">{t.seo.structuredDataValid}</Badge>
                    ) : (
                      <BlockStack gap="200">
                        {block.warnings.map((w, i) => {
                          // Remix's JsonifyObject drops the `code` string-union
                          // through Jsonify, so read it via a widening cast.
                          const code = (w as unknown as { code: string }).code;
                          const localizedMessage = warningCopy?.[code] || w.message;
                          const hint = hintCopy?.[code] || "";
                          const linkKind = FIX_LINK_BY_CODE[code];
                          const fixUrl = linkKind ? fixUrlFor(linkKind) : null;
                          const fixLabel = linkKind ? fixLabelFor(linkKind) : "";
                          return (
                            <BlockStack key={i} gap="100">
                              <InlineStack gap="100" blockAlign="center">
                                <Badge tone={severityTone(w.severity)}>
                                  {severityCopy?.[w.severity] || w.severity}
                                </Badge>
                                <Text as="span" variant="bodySm">
                                  {localizedMessage}
                                </Text>
                              </InlineStack>
                              {hint ? (
                                <Text as="p" variant="bodySm" tone="subdued">
                                  {hint}
                                </Text>
                              ) : null}
                              {/* Every fix-up here is an external admin link:
                                  the embed one goes straight to its switch in
                                  the theme editor. */}
                              {linkKind === "themeEditorJsonLd" ? (
                                <InlineStack>
                                  <Button url={jsonLdEmbedUrl} target="_blank" variant="plain">
                                    {fixLabel}
                                  </Button>
                                </InlineStack>
                              ) : fixUrl ? (
                                <InlineStack>
                                  <Button url={fixUrl} target="_blank" variant="plain">
                                    {fixLabel}
                                  </Button>
                                </InlineStack>
                              ) : null}
                            </BlockStack>
                          );
                        })}
                      </BlockStack>
                    )}
                    <pre
                      style={{
                        maxHeight: "260px",
                        overflow: "auto",
                        background: "#f6f6f7",
                        padding: "8px",
                        borderRadius: "4px",
                        fontSize: "11px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                      }}
                    >
                      {block.code}
                    </pre>
                  </BlockStack>
                ))
              )}
            </BlockStack>
          </Card>
          {/* Phase 5 (PLAN_SEO_SUITE_COMPLETION.md §7): validateJsonLd over the
              WHOLE cached catalog instead of one example item per type,
              aggregated by warning code. */}
          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between" blockAlign="center">
                <Text as="h2" variant="headingLg">
                  {b.title}
                </Text>
                <Button onClick={handleCheckNow} disabled={checkInProgress || checkFetcher.state !== "idle"} loading={checkFetcher.state !== "idle"}>
                  {b.checkNow}
                </Button>
              </InlineStack>
              <Text as="p" variant="bodyMd" tone="subdued">
                {b.intro}
              </Text>

              {checkBanner && (
                <Banner tone={checkBanner.tone} onDismiss={() => setCheckBanner(null)}>
                  {checkBanner.message}
                </Banner>
              )}
              {!checkBanner && checkInProgress && <Banner tone="info">{b.checking}</Banner>}

              <Text as="p" variant="bodySm" tone="subdued">
                {jsonLdAudit
                  ? b.lastChecked.replace("{time}", new Date(jsonLdAudit.generatedAt).toLocaleString())
                  : b.neverChecked}
              </Text>

              {jsonLdAudit && (
                <BlockStack gap="200">
                  <Text as="p" variant="bodySm">
                    {b.totalScanned
                      .replace("{scanned}", String(jsonLdAudit.totalScanned))
                      .replace("{available}", String(jsonLdAudit.totalAvailable))}
                  </Text>
                  {jsonLdAudit.capped && <Banner tone="warning">{b.capped}</Banner>}

                  {jsonLdAudit.buckets.length === 0 ? (
                    <Badge tone="success">{b.empty}</Badge>
                  ) : (
                    <DataTable
                      columnContentTypes={["text", "text", "numeric", "text"]}
                      headings={[b.codeColumn, "", b.countColumn, b.itemsColumn]}
                      rows={jsonLdAudit.buckets.map((bucket) => {
                        const localizedCode = warningCopy?.[bucket.code] || bucket.code;
                        const visibleItems = bucket.items.slice(0, 10);
                        const remaining = bucket.count - visibleItems.length;
                        return [
                          localizedCode,
                          <Badge key="sev" tone={severityTone(bucket.severity)}>
                            {bucket.severity === "error"
                              ? b.severityError
                              : bucket.severity === "info"
                              ? b.severityInfo
                              : b.severityWarning}
                          </Badge>,
                          bucket.count,
                          <BlockStack key="items" gap="100">
                            {visibleItems.map((item) => (
                              <InlineStack key={item.id} gap="100" blockAlign="center">
                                <Button
                                  variant="plain"
                                  onClick={() => openBatchItemInEditor(item.type, item.id)}
                                >
                                  {item.title}
                                </Button>
                                {item.url && (
                                  <Button
                                    variant="plain"
                                    url={`${GOOGLE_RICH_RESULTS_TEST}?url=${encodeURIComponent(item.url)}`}
                                    target="_blank"
                                  >
                                    {b.richResultsTest}
                                  </Button>
                                )}
                              </InlineStack>
                            ))}
                            {remaining > 0 && (
                              <Text as="span" variant="bodySm" tone="subdued">
                                {b.moreItems.replace("{count}", String(remaining))}
                              </Text>
                            )}
                          </BlockStack>,
                        ];
                      })}
                    />
                  )}
                </BlockStack>
              )}
            </BlockStack>
          </Card>
          </BlockStack>
        )}

        {/* Step 3 — which switches may be turned on, judged against step 1.
            Nothing here writes anything: the app never flips its own storefront
            blocks off the back of a crawl finding (plan §4). It reports; the
            merchant decides, in the theme editor. */}
        {step === "activate" && (
          <BlockStack gap="400">
            <Text as="p" variant="bodyMd" tone="subdued">{emphasize(act.intro as string)}</Text>
            {/* Each embed is its own card: its own verdict, its own bottom line
                and its own way into the theme editor, right next to the verdict
                rather than at the foot of the page. The two are gated
                separately because the social columns are younger than the
                JSON-LD ones — a snapshot can know one half and not the other,
                and a shared banner would claim knowledge for a half nobody
                looked at. */}
            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="h2" variant="headingMd">{act.switchesTitle as string}</Text>
                    {jsonLdMeasured && (
                      <Badge tone={activationTone(jsonLdBadge)}>
                        {(act.verdictLabels as Record<string, string>)[jsonLdBadge]}
                      </Badge>
                    )}
                  </InlineStack>
                  <Button url={jsonLdEmbedUrl} target="_blank" variant="primary">
                    {act.openSwitches as string}
                  </Button>
                </InlineStack>

                {!jsonLdMeasured ? (
                  // The core rule of this section, restated in place: a missing
                  // measurement is not a free pass. No crawl ⇒ no verdict, only
                  // the invitation to run step 1.
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        {emphasize(liveJsonLd ? (act.notMeasured as string) : (act.noCrawl as string))}
                      </Text>
                      <div>
                        <Button onClick={() => handleNavigate("/app/seo/crawl")}>
                          {live.goToCrawl}
                        </Button>
                      </div>
                    </BlockStack>
                  </Banner>
                ) : (
                  renderVerdictSummary(
                    switchGates.map((sw) => ({
                      label: (act.switches as Record<string, string>)[sw.labelKey],
                      verdict: sw.gate.verdict,
                    })),
                    true,
                  )
                )}

                {jsonLdMeasured && !jsonLdOriginKnown && (
                  // Without the marker every "not ours" reading collapses to
                  // "we could not tell" — said once, not under all seven rows.
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm">{emphasize(act.originUnknownHint as string)}</Text>
                      <div>
                        <Button size="slim" onClick={() => handleNavigate("/app/seo/crawl")}>
                          {live.goToCrawl}
                        </Button>
                      </div>
                    </BlockStack>
                  </Banner>
                )}

                <BlockStack gap="0">
                  {switchGates.map((sw) =>
                    renderGateRow({
                      key: sw.settingId,
                      label: (act.switches as Record<string, string>)[sw.labelKey],
                      settingId: sw.settingId,
                      gate: sw.gate,
                      defaultOn: sw.defaultOn,
                      examples: liveJsonLd?.duplicates.find((d) => d.type === sw.type)?.examples ?? [],
                    }),
                  )}
                </BlockStack>

                {jsonLdMeasured && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {(act.basis as string)
                      .replace("{time}", new Date(liveJsonLd!.crawledAt).toLocaleString())
                      .replace("{pages}", String(liveJsonLd!.pagesChecked))}
                  </Text>
                )}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <InlineStack align="space-between" blockAlign="center" gap="200" wrap>
                  <InlineStack gap="200" blockAlign="center" wrap>
                    <Text as="h2" variant="headingMd">{act.socialSwitchesTitle as string}</Text>
                    {socialMeasured && (
                      <Badge tone={activationTone(socialBadge)}>
                        {(act.verdictLabels as Record<string, string>)[socialBadge]}
                      </Badge>
                    )}
                  </InlineStack>
                  <Button url={socialEmbedUrl} target="_blank" variant="primary">
                    {act.openSwitches as string}
                  </Button>
                </InlineStack>
                <Text as="p" variant="bodySm" tone="subdued">
                  {act.socialSwitchesBody as string}
                </Text>

                {!socialMeasured ? (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodyMd">
                        {emphasize(liveSocial ? (act.socialNotMeasured as string) : (act.noCrawl as string))}
                      </Text>
                      <div>
                        <Button onClick={() => handleNavigate("/app/seo/crawl")}>
                          {live.goToCrawl}
                        </Button>
                      </div>
                    </BlockStack>
                  </Banner>
                ) : (
                  renderVerdictSummary(
                    socialGates.map((sg) => ({ label: sg.tag, verdict: sg.gate.verdict })),
                    true,
                  )
                )}

                {socialMeasured && !socialOriginKnown && (
                  <Banner tone="info">
                    <BlockStack gap="200">
                      <Text as="p" variant="bodySm">{emphasize(act.socialOriginUnknownHint as string)}</Text>
                      <div>
                        <Button size="slim" onClick={() => handleNavigate("/app/seo/crawl")}>
                          {live.goToCrawl}
                        </Button>
                      </div>
                    </BlockStack>
                  </Banner>
                )}

                <BlockStack gap="0">
                  {socialGates.map((sg) =>
                    renderGateRow({
                      key: sg.tag,
                      label: sg.tag,
                      // Proper nouns, identical in all three shipped languages —
                      // an i18n key here would only be a place for them to drift.
                      settingId: sg.tag.startsWith("og:") ? "Open Graph" : "Twitter Card",
                      gate: sg.gate,
                      examples: liveSocial?.duplicates.find((d) => d.tag === sg.tag)?.examples ?? [],
                    }),
                  )}
                </BlockStack>

                {socialMeasured && (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {(act.basis as string)
                      .replace("{time}", new Date(liveSocial!.crawledAt).toLocaleString())
                      .replace("{pages}", String(liveSocial!.pagesChecked))}
                  </Text>
                )}
              </BlockStack>
            </Card>

            {/* The app names the conflict; it does not resolve it in the
                merchant's theme code (plan §4, and the standing rule that this
                app never edits theme code it does not own). */}
            <Text as="p" variant="bodySm" tone="subdued">{emphasize(act.themeHint as string)}</Text>
          </BlockStack>
        )}

      </BlockStack>
    </SeoSectionLayout>
  );
}
