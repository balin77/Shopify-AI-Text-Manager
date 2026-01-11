import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  Page,
  Card,
  Text,
  BlockStack,
  InlineStack,
  Badge,
  Layout,
  Divider,
  Tabs,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";
import { useState } from "react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const fetchTranslatable = async (resourceIds: string[]) => {
    const results = [];

    for (const id of resourceIds) {
      try {
        const translatableQuery = `#graphql
          query getTranslatable($id: ID!) {
            translatableResource(resourceId: $id) {
              resourceId
              translatableContent {
                key
                value
                digest
                locale
              }
              translations {
                locale
                key
                value
                outdated
              }
            }
          }
        `;

        const response = await admin.graphql(translatableQuery, {
          variables: { id }
        });
        const data = await response.json();

        if (data.data?.translatableResource) {
          results.push({
            id,
            translatable: data.data.translatableResource
          });
        }
      } catch (error) {
        console.error(`Error fetching translatable resource for ${id}:`, error);
      }
    }

    return results;
  };

  try {
    // Fetch Collections
    const collectionsQuery = `#graphql
      query {
        collections(first: 10) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    `;
    const collResponse = await admin.graphql(collectionsQuery);
    const collData = await collResponse.json();
    const collections = collData.data?.collections?.edges?.map((e: any) => e.node) || [];
    const collectionsTranslatable = await fetchTranslatable(collections.map((c: any) => c.id));

    // Fetch Pages
    const pagesQuery = `#graphql
      query {
        pages(first: 10) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    `;
    const pagesResponse = await admin.graphql(pagesQuery);
    const pagesData = await pagesResponse.json();
    const pages = pagesData.data?.pages?.edges?.map((e: any) => e.node) || [];
    const pagesTranslatable = await fetchTranslatable(pages.map((p: any) => p.id));

    // Fetch Blogs/Articles
    const blogsQuery = `#graphql
      query {
        articles(first: 10) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    `;
    const blogsResponse = await admin.graphql(blogsQuery);
    const blogsData = await blogsResponse.json();
    const blogs = blogsData.data?.articles?.edges?.map((e: any) => e.node) || [];
    const blogsTranslatable = await fetchTranslatable(blogs.map((b: any) => b.id));

    // Fetch Menus
    const menusQuery = `#graphql
      query {
        menus(first: 10) {
          edges {
            node {
              id
              title
              handle
            }
          }
        }
      }
    `;
    const menusResponse = await admin.graphql(menusQuery);
    const menusData = await menusResponse.json();
    const menus = menusData.data?.menus?.edges?.map((e: any) => e.node) || [];
    const menusTranslatable = await fetchTranslatable(menus.map((m: any) => m.id));

    // Create lookup maps for translatable resources
    const collectionsMap = new Map(collectionsTranslatable.map(t => [t.id, t.translatable]));
    const pagesMap = new Map(pagesTranslatable.map(t => [t.id, t.translatable]));
    const blogsMap = new Map(blogsTranslatable.map(t => [t.id, t.translatable]));
    const menusMap = new Map(menusTranslatable.map(t => [t.id, t.translatable]));

    console.log('=== TRANSLATABLE DEBUG COUNTS ===');
    console.log('Collections:', collections.length, 'translatable:', collectionsTranslatable.length);
    console.log('Pages:', pages.length, 'translatable:', pagesTranslatable.length);
    console.log('Blogs:', blogs.length, 'translatable:', blogsTranslatable.length);
    console.log('Menus:', menus.length, 'translatable:', menusTranslatable.length);

    return json({
      collections: collections.map((c: any) => ({
        ...c,
        translatable: collectionsMap.get(c.id)
      })).filter((c: any) => c.translatable),
      pages: pages.map((p: any) => ({
        ...p,
        translatable: pagesMap.get(p.id)
      })).filter((p: any) => p.translatable),
      blogs: blogs.map((b: any) => ({
        ...b,
        translatable: blogsMap.get(b.id)
      })).filter((b: any) => b.translatable),
      menus: menus.map((m: any) => ({
        ...m,
        translatable: menusMap.get(m.id)
      })).filter((m: any) => m.translatable),
      shop: session.shop
    });
  } catch (error) {
    console.error('Error in translatable debug loader:', error);
    return json({
      collections: [],
      pages: [],
      blogs: [],
      menus: [],
      shop: session.shop,
      error: String(error)
    });
  }
};

export default function TranslatableDebugPage() {
  const { collections, pages, blogs, menus, shop, error } = useLoaderData<typeof loader>();
  const [selectedTab, setSelectedTab] = useState(0);

  const tabs = [
    { id: "collections", content: `Collections (${collections.length})`, panel: collections },
    { id: "pages", content: `Pages (${pages.length})`, panel: pages },
    { id: "blogs", content: `Blogs (${blogs.length})`, panel: blogs },
    { id: "menus", content: `Menus (${menus.length})`, panel: menus },
  ];

  const renderResource = (resource: any) => (
    <Card key={resource.id}>
      <BlockStack gap="500">
        {/* Header */}
        <BlockStack gap="100">
          <Text as="h3" variant="headingMd">
            {resource.title}
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            ID: {resource.id}
          </Text>
          {resource.handle && (
            <Text as="p" tone="subdued" variant="bodySm">
              Handle: {resource.handle}
            </Text>
          )}
        </BlockStack>

        <Divider />

        {/* Translatable Content */}
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h4" variant="headingSm">
              Translatable Content (Available Fields)
            </Text>
            <Badge tone="success">
              {resource.translatable.translatableContent?.length || 0} fields
            </Badge>
          </InlineStack>

          {resource.translatable.translatableContent?.length > 0 ? (
            <BlockStack gap="200">
              {resource.translatable.translatableContent.map((content: any, idx: number) => (
                <Card key={idx} background="bg-surface-secondary">
                  <BlockStack gap="200">
                    <InlineStack gap="300" blockAlign="start">
                      <div style={{ minWidth: "150px" }}>
                        <Text as="span" fontWeight="bold">Key:</Text>{" "}
                        <Badge tone="info">{content.key}</Badge>
                      </div>
                      <div style={{ minWidth: "100px" }}>
                        <Text as="span" fontWeight="bold">Locale:</Text>{" "}
                        <Badge>{content.locale}</Badge>
                      </div>
                    </InlineStack>
                    <div>
                      <Text as="p" fontWeight="bold">Value:</Text>
                      <Text as="p" tone="subdued" breakWord>
                        {content.value.substring(0, 200)}{content.value.length > 200 ? "..." : ""}
                      </Text>
                    </div>
                    <div>
                      <Text as="p" fontWeight="bold" variant="bodySm">Digest:</Text>
                      <Text as="p" tone="subdued" variant="bodySm" breakWord>
                        {content.digest.substring(0, 50)}...
                      </Text>
                    </div>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          ) : (
            <Text as="p" tone="subdued">
              No translatable content available
            </Text>
          )}
        </BlockStack>

        <Divider />

        {/* Translations */}
        <BlockStack gap="300">
          <InlineStack gap="200" blockAlign="center">
            <Text as="h4" variant="headingSm">
              Existing Translations
            </Text>
            <Badge tone="attention">
              {resource.translatable.translations?.length || 0} translations
            </Badge>
          </InlineStack>

          {resource.translatable.translations?.length > 0 ? (
            <BlockStack gap="200">
              {resource.translatable.translations.map((translation: any, idx: number) => (
                <Card key={idx} background="bg-surface-tertiary">
                  <BlockStack gap="200">
                    <InlineStack gap="300" blockAlign="start">
                      <div style={{ minWidth: "150px" }}>
                        <Text as="span" fontWeight="bold">Key:</Text>{" "}
                        <Badge tone="info">{translation.key}</Badge>
                      </div>
                      <div style={{ minWidth: "100px" }}>
                        <Text as="span" fontWeight="bold">Locale:</Text>{" "}
                        <Badge>{translation.locale}</Badge>
                      </div>
                      {translation.outdated && (
                        <Badge tone="warning">Outdated</Badge>
                      )}
                    </InlineStack>
                    <div>
                      <Text as="p" fontWeight="bold">Value:</Text>
                      <Text as="p" tone="subdued" breakWord>
                        {translation.value.substring(0, 200)}{translation.value.length > 200 ? "..." : ""}
                      </Text>
                    </div>
                  </BlockStack>
                </Card>
              ))}
            </BlockStack>
          ) : (
            <Text as="p" tone="subdued">
              No translations available
            </Text>
          )}
        </BlockStack>
      </BlockStack>
    </Card>
  );

  return (
    <>
      <MainNavigation />
      <Page
        title="Translatable Resources Debug"
        subtitle={`Shop: ${shop}`}
        backAction={{ content: "Content", url: "/app/content" }}
      >
        <Layout>
          <Layout.Section>
            {error && (
              <Card>
                <Text as="p" tone="critical">
                  Error: {error}
                </Text>
              </Card>
            )}

            <BlockStack gap="600">
              <Card>
                <BlockStack gap="400">
                  <Text as="h2" variant="headingLg">
                    Overview
                  </Text>
                  <Text as="p">
                    This page shows all translatable content that Shopify provides for all content types (except Products).
                    It queries the <code>translatableResource</code> API for each item to see what fields
                    are available for translation.
                  </Text>
                </BlockStack>
              </Card>

              <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
                <BlockStack gap="400" inlineAlign="stretch">
                  <div style={{ marginTop: "1rem" }}>
                    <BlockStack gap="400">
                      {tabs[selectedTab].panel.length > 0 ? (
                        tabs[selectedTab].panel.map((resource: any) => renderResource(resource))
                      ) : (
                        <Card>
                          <Text as="p" tone="subdued">
                            No {tabs[selectedTab].id} found or no translatable resources available.
                          </Text>
                        </Card>
                      )}
                    </BlockStack>
                  </div>
                </BlockStack>
              </Tabs>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
