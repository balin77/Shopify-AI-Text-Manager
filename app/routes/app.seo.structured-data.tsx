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

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const { db } = await import("../db.server");
  const shop = session.shop;

  const shopInfo: ShopInfo = {
    domain: shop,
    name: shop.replace(/\.myshopify\.com$/, ""),
  };

  const [product, collection, article] = await Promise.all([
    db.product.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: { title: true, descriptionHtml: true, handle: true, seoDescription: true, featuredImageUrl: true },
    }),
    db.collection.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: { title: true, descriptionHtml: true, handle: true, seoDescription: true },
    }),
    db.article.findFirst({
      where: { shop },
      orderBy: { lastSyncedAt: "desc" },
      select: { title: true, body: true, handle: true, blogTitle: true, imageUrl: true, shopifyUpdatedAt: true },
    }),
  ]);

  const previews: PreviewBlock[] = [];

  // Organization is always previewable (built from the shop alone).
  const org = buildOrganizationJsonLd(shopInfo);
  previews.push({ labelKey: "schemaOrganization", code: renderJsonLdScript(org), warnings: validateJsonLd(org) });

  if (product) {
    const p = buildProductJsonLd(
      {
        title: product.title,
        descriptionHtml: product.descriptionHtml,
        handle: product.handle,
        seoDescription: product.seoDescription,
        featuredImageUrl: product.featuredImageUrl,
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

  return json({ previews, themeEditorUrl, themeEditorUrlSocialMeta });
};

export default function SeoStructuredData() {
  const { previews, themeEditorUrl, themeEditorUrlSocialMeta } = useLoaderData<typeof loader>();
  const { t } = useI18n();
  const s = (t.seo as any).structuredDataPage;

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
                  {s[k]}
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
                    {s[block.labelKey]}
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
