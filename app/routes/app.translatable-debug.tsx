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
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  try {
    // First, get all menus
    const menusQuery = `#graphql
      query getMenus {
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
    const menus = menusData.data?.menus?.edges?.map((edge: any) => edge.node) || [];

    // For each menu, fetch its translatableResource
    const translatableResources = [];

    for (const menu of menus) {
      try {
        const translatableQuery = `#graphql
          query getTranslatableMenu($id: ID!) {
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

        const translatableResponse = await admin.graphql(translatableQuery, {
          variables: { id: menu.id }
        });
        const translatableData = await translatableResponse.json();

        if (translatableData.data?.translatableResource) {
          translatableResources.push({
            menu,
            translatable: translatableData.data.translatableResource
          });
        }
      } catch (error) {
        console.error(`Error fetching translatable resource for menu ${menu.id}:`, error);
      }
    }

    return json({
      translatableResources,
      shop: session.shop
    });
  } catch (error) {
    console.error('Error in translatable debug loader:', error);
    return json({
      translatableResources: [],
      shop: session.shop,
      error: String(error)
    });
  }
};

export default function TranslatableDebugPage() {
  const { translatableResources, shop, error } = useLoaderData<typeof loader>();

  return (
    <>
      <MainNavigation />
      <Page
        title="Translatable Resources Debug"
        subtitle={`Shop: ${shop} - Direct link: /app/translatable-debug`}
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
                    This page shows all translatable content that Shopify provides for Menu resources.
                    It queries the <code>translatableResource</code> API for each menu to see what fields
                    are available for translation.
                  </Text>
                  <InlineStack gap="300">
                    <Badge tone="info">Total Menus: {translatableResources.length}</Badge>
                  </InlineStack>
                </BlockStack>
              </Card>

              {translatableResources.map((resource: any, index: number) => (
                <Card key={index}>
                  <BlockStack gap="500">
                    {/* Menu Header */}
                    <InlineStack align="space-between" blockAlign="center">
                      <BlockStack gap="100">
                        <Text as="h3" variant="headingMd">
                          {resource.menu.title}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          ID: {resource.menu.id}
                        </Text>
                        <Text as="p" tone="subdued" variant="bodySm">
                          Handle: {resource.menu.handle}
                        </Text>
                      </BlockStack>
                    </InlineStack>

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
                                    {content.value}
                                  </Text>
                                </div>
                                <div>
                                  <Text as="p" fontWeight="bold" variant="bodySm">Digest:</Text>
                                  <Text as="p" tone="subdued" variant="bodySm" breakWord>
                                    {content.digest}
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
                                    {translation.value}
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
              ))}

              {translatableResources.length === 0 && !error && (
                <Card>
                  <Text as="p" tone="subdued">
                    No menus found or no translatable resources available.
                  </Text>
                </Card>
              )}
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
