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
import { useEffect, useRef, useState } from "react";
import { Card, BlockStack, InlineStack, InlineGrid, Text, Badge, Button, Banner, DataTable } from "@shopify/polaris";
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
  const liveJsonLd = await summarizeLiveJsonLd(db, shop).catch(() => null);

  return json({
    previews,
    brandingUrl,
    sampleProductAdminUrl,
    sampleArticleAdminUrl,
    jsonLdAudit,
    jsonLdAuditRunning: !!runningJsonLdAuditTask,
    liveJsonLd,
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
    previews,
    brandingUrl,
    sampleProductAdminUrl,
    sampleArticleAdminUrl,
    jsonLdAudit,
    jsonLdAuditRunning,
    liveJsonLd,
  } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const { handleNavigate } = useAppNavigation();
  const s = t.seo.structuredDataPage;
  const b = (s as any).batch as Record<string, string>;
  const warningCopy = (s as any).warnings as Record<string, string>;
  const live = (s as any).live as Record<string, string>;

  /** Every app embed is activated in Settings → Setup, not from here. */
  const openEmbedSettings = () =>
    handleNavigate("/app/settings", { searchParams: new URLSearchParams({ tab: "setup" }) });

  // Delivery before data quality: markup that never reaches the page makes the
  // catalog report moot, so step 1 is what the storefront actually serves.
  const [step, setStep] = useState<"delivery" | "data">("delivery");

  // Each tile carries its own verdict. "Unknown" is a real state for both and
  // must not be dressed up as a clean result: no crawl yet on the left, never
  // run on the right.
  const deliveryBadge = !liveJsonLd || liveJsonLd.notMeasured ? (
    <Badge>{live.badgeUnknown}</Badge>
  ) : liveJsonLd.duplicates.length > 0 ? (
    <Badge tone="critical">{live.badgeDuplicates}</Badge>
  ) : liveJsonLd.coverage.some((c) => c.withMarkup < c.total) ? (
    <Badge tone="warning">{live.badgeGaps}</Badge>
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

        {/* 2. Activation in the theme editor (the two app-embed blocks) */}
        <Card>
          <BlockStack gap="400">
            <Text as="h2" variant="headingLg">
              {(s as any).activationTitle as string}
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              {(s as any).activationBody as string}
            </Text>

            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                {(s as any).activationJsonLdTitle as string}
              </Text>
              <InlineStack>
                <Button onClick={openEmbedSettings} variant="primary">
                  {(s as any).activateInSettings as string}
                </Button>
              </InlineStack>
            </BlockStack>

            <BlockStack gap="200">
              <Text as="h3" variant="headingMd">
                {(s as any).activationOgTitle as string}
              </Text>
              <InlineStack>
                <Button onClick={openEmbedSettings} variant="primary">
                  {(s as any).activateInSettings as string}
                </Button>
              </InlineStack>
            </BlockStack>
          </BlockStack>
        </Card>

        {/* The two halves are sequential, not a pair — markup has to reach the
            page before its data quality means anything — so they are steps, in
            the same shape the AEO section uses for robots.txt/llms.txt. */}
        <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
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
        </InlineGrid>

        {/* Step 1 — what the storefront actually serves (from the last crawl).
            The only place in the app that reads a real page. */}
        {step === "delivery" && (
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
        )}

        {/* Step 2 — whether the CATALOG carries the data a rich result needs.
            Reads the DB cache, never a live page. */}
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
                {/* Both of these come from native media / a metafield on the
                    storefront, so they have no counterpart in the preview
                    below — which is built from the DB cache. Saying so beats
                    letting a merchant conclude the video markup is missing. */}
                <Text as="p" variant="bodySm" tone="subdued">
                  {(s as any).schemaVideoNote as string}
                </Text>
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
                                  {w.severity}
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
                              {/* The embed fix-up is an in-app navigation to
                                  Settings → Setup; the others are external
                                  admin links. */}
                              {linkKind === "themeEditorJsonLd" ? (
                                <InlineStack>
                                  <Button onClick={openEmbedSettings} variant="plain">
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
          // Phase 5 (PLAN_SEO_SUITE_COMPLETION.md §7): validateJsonLd over the
          // WHOLE cached catalog instead of one example item per type,
          // aggregated by warning code.
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

      </BlockStack>
    </SeoSectionLayout>
  );
}
