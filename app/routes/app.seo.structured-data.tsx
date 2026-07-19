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

import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Card, BlockStack, InlineStack, Text, Badge, Button, Banner } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { useI18n } from "../contexts/I18nContext";
import { SeoSectionLayout } from "../components/seo/SeoSectionLayout";
import {
  buildOrganizationJsonLd,
  buildProductJsonLd,
  buildCollectionJsonLd,
  buildArticleJsonLd,
  renderJsonLdScript,
  validateJsonLd,
  type ShopInfo,
  type JsonLdWarning,
} from "../services/structured-data.service";

const GOOGLE_RICH_RESULTS_TEST = "https://search.google.com/test/rich-results";

function slug(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
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
      // logoUrl is intentionally unset — see FIELD-EXISTENCE NOTES above.
    };
  } catch {
    return {
      name: fallbackShop.replace(/\.myshopify\.com$/, ""),
      domain: fallbackShop,
    };
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

  const [shopInfo, productLive, articlePublishedAt] = await Promise.all([
    fetchShopInfo(admin, shop),
    product ? fetchProductPreviewData(admin, product.id) : Promise.resolve(null),
    article ? fetchArticlePublishedAt(admin, article.id) : Promise.resolve(null),
  ]);

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
        blogHandle: slug(article.blogTitle || ""),
        imageUrl: article.imageUrl,
        publishedAt: articlePublishedAt,
        updatedAt: article.shopifyUpdatedAt,
      },
      shopInfo,
    );
    previews.push({ labelKey: "schemaArticle", code: renderJsonLdScript(a), warnings: validateJsonLd(a) });
  }

  const apiKey = process.env.SHOPIFY_API_KEY || "";
  const themeEditorUrl = apiKey
    ? `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/structured-data`
    : `https://${shop}/admin/themes/current/editor?context=apps`;
  const themeEditorUrlSocialMeta = apiKey
    ? `https://${shop}/admin/themes/current/editor?context=apps&activateAppId=${apiKey}/social-meta`
    : `https://${shop}/admin/themes/current/editor?context=apps`;
  // Direct link to Settings → Brand where `shop.brand.logo` (the field the
  // Storefront Liquid block reads for the Organization JSON-LD logo) is set.
  // Shown next to the Organization "no logo" warning so the merchant can
  // fix it in one click.
  const brandingUrl = `https://${shop}/admin/settings/general/branding`;

  return json({ previews, themeEditorUrl, themeEditorUrlSocialMeta, brandingUrl });
};

// Matches the exact wording emitted by structured-data.service.validateJsonLd
// so we can attach a Settings-link fix-up next to it. If the copy in the
// service changes, keep this in sync.
const ORG_LOGO_WARNING = "Organization has no logo — recommended for knowledge panel.";

export default function SeoStructuredData() {
  const { previews, themeEditorUrl, themeEditorUrlSocialMeta, brandingUrl } =
    useLoaderData<typeof loader>();
  const { t } = useI18n();
  const s = t.seo.structuredDataPage;

  const schemaTypeKeys = [
    "schemaProduct",
    "schemaCollection",
    "schemaArticle",
    "schemaOrganization",
    "schemaBreadcrumb",
  ];

  return (
    <SeoSectionLayout sectionId="structuredData">
      <BlockStack gap="400">
        {/* Status */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {s.statusTitle}
            </Text>
            <Banner tone="info">{s.statusUnknown}</Banner>
            <InlineStack>
              <Button url={themeEditorUrl} target="_blank" variant="primary">
                {s.activateInThemeEditor}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Open Graph / Twitter Cards (plan §C4) */}
        <Card>
          <BlockStack gap="300">
            <Text as="h3" variant="headingMd">
              {s.ogTitle}
            </Text>
            <Banner tone="info">{s.ogBody}</Banner>
            <InlineStack>
              <Button url={themeEditorUrlSocialMeta} target="_blank" variant="primary">
                {s.ogActivate}
              </Button>
            </InlineStack>
          </BlockStack>
        </Card>

        {/* How it works */}
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              {s.howItWorks}
            </Text>
            <Text as="p" variant="bodyMd" tone="subdued">
              {s.howItWorksBody}
            </Text>
          </BlockStack>
        </Card>

        {/* Active schema types */}
        <Card>
          <BlockStack gap="200">
            <Text as="h3" variant="headingMd">
              {s.schemaTypesTitle}
            </Text>
            <InlineStack gap="200" wrap>
              {schemaTypeKeys.map((k) => (
                <Badge key={k} tone="success">
                  {(s as Record<string, string>)[k]}
                </Badge>
              ))}
            </InlineStack>
          </BlockStack>
        </Card>

        {/* Live preview */}
        <Card>
          <BlockStack gap="300">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h3" variant="headingMd">
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
                <BlockStack key={block.labelKey} gap="100">
                  <Text as="p" variant="headingSm">
                    {(s as Record<string, string>)[block.labelKey]}
                  </Text>
                  {block.warnings.length === 0 ? (
                    <Badge tone="success">{t.seo.structuredDataValid}</Badge>
                  ) : (
                    <BlockStack gap="100">
                      {block.warnings.map((w, i) => (
                        <InlineStack key={i} gap="100" blockAlign="center">
                          <Badge tone={w.severity === "error" ? "critical" : "warning"}>
                            {w.severity}
                          </Badge>
                          <Text as="span" variant="bodySm">
                            {w.message}
                          </Text>
                          {w.message === ORG_LOGO_WARNING ? (
                            <Button url={brandingUrl} target="_blank" variant="plain">
                              {s.setBrandLogo}
                            </Button>
                          ) : null}
                        </InlineStack>
                      ))}
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
      </BlockStack>
    </SeoSectionLayout>
  );
}
