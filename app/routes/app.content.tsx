import { useState } from "react";
import { json, type LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import { Page, Card, Text, BlockStack, InlineStack } from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { MainNavigation } from "../components/MainNavigation";

type ContentType = "menus" | "blogs" | "collections" | "pages" | "theme";

const CONTENT_TYPES = [
  { id: "menus" as ContentType, label: "Menüs", icon: "☰" },
  { id: "blogs" as ContentType, label: "Blogs", icon: "📝" },
  { id: "collections" as ContentType, label: "Kollektionen", icon: "📂" },
  { id: "pages" as ContentType, label: "Seiten", icon: "📄" },
  { id: "theme" as ContentType, label: "Theme-Texte", icon: "🎨" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return json({ shop: session.shop });
};

export default function ContentPage() {
  const { shop } = useLoaderData<typeof loader>();
  const [selectedType, setSelectedType] = useState<ContentType>("menus");

  return (
    <Page fullWidth>
      <MainNavigation />
      <div style={{ padding: "1rem" }}>
        {/* Sub-Navigation for Content Types */}
        <Card padding="0">
          <div style={{ borderBottom: "1px solid #e1e3e5", padding: "1rem" }}>
            <InlineStack gap="300">
              {CONTENT_TYPES.map((type) => (
                <button
                  key={type.id}
                  onClick={() => setSelectedType(type.id)}
                  style={{
                    padding: "0.75rem 1.5rem",
                    border: selectedType === type.id ? "2px solid #008060" : "1px solid #c9cccf",
                    borderRadius: "8px",
                    background: selectedType === type.id ? "#f1f8f5" : "white",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.5rem",
                  }}
                >
                  <span style={{ fontSize: "1.2rem" }}>{type.icon}</span>
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight={selectedType === type.id ? "semibold" : "regular"}
                  >
                    {type.label}
                  </Text>
                </button>
              ))}
            </InlineStack>
          </div>

          <div style={{ padding: "2rem" }}>
            <BlockStack gap="400">
              {selectedType === "menus" && (
                <ContentSection
                  title="Menüs"
                  description="Verwalten und übersetzen Sie Ihre Shop-Navigation und Menüs"
                  status="coming-soon"
                />
              )}
              {selectedType === "blogs" && (
                <ContentSection
                  title="Blog-Beiträge"
                  description="Erstellen und übersetzen Sie Blog-Artikel mit KI-Unterstützung"
                  status="coming-soon"
                />
              )}
              {selectedType === "collections" && (
                <ContentSection
                  title="Kollektionen"
                  description="Bearbeiten und übersetzen Sie Produktkollektionen"
                  status="coming-soon"
                />
              )}
              {selectedType === "pages" && (
                <ContentSection
                  title="Seiten"
                  description="Verwalten Sie Ihre Shop-Seiten (Impressum, AGB, etc.)"
                  status="coming-soon"
                />
              )}
              {selectedType === "theme" && (
                <ContentSection
                  title="Theme-Texte"
                  description="Übersetzen Sie Theme-Texte wie Buttons, Labels und Meldungen"
                  status="coming-soon"
                />
              )}
            </BlockStack>
          </div>
        </Card>
      </div>
    </Page>
  );
}

function ContentSection({
  title,
  description,
  status,
}: {
  title: string;
  description: string;
  status: "coming-soon" | "active";
}) {
  return (
    <div
      style={{
        padding: "2rem",
        border: "1px solid #e1e3e5",
        borderRadius: "8px",
        textAlign: "center",
      }}
    >
      <BlockStack gap="300">
        <Text as="h2" variant="headingLg">
          {title}
        </Text>
        <Text as="p" variant="bodyMd" tone="subdued">
          {description}
        </Text>
        {status === "coming-soon" && (
          <div
            style={{
              display: "inline-block",
              padding: "0.5rem 1rem",
              background: "#fef3c7",
              borderRadius: "6px",
              marginTop: "1rem",
            }}
          >
            <Text as="span" variant="bodySm" fontWeight="semibold">
              Demnächst verfügbar
            </Text>
          </div>
        )}
      </BlockStack>
    </div>
  );
}
