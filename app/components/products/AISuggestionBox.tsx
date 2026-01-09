import { Text, BlockStack, InlineStack, Button } from "@shopify/polaris";

interface AISuggestionBoxProps {
  suggestion: string;
  isHtml?: boolean;
  onAccept: () => void;
  onAcceptAndTranslate: () => void;
  onReject: () => void;
}

export function AISuggestionBox({
  suggestion,
  isHtml = false,
  onAccept,
  onAcceptAndTranslate,
  onReject,
}: AISuggestionBoxProps) {
  return (
    <div
      style={{
        marginTop: "0.5rem",
        padding: "1rem",
        background: "#f0f9ff",
        border: "1px solid #0891b2",
        borderRadius: "8px",
      }}
    >
      <BlockStack gap="300">
        <Text as="p" variant="bodyMd" fontWeight="semibold">
          KI-Vorschlag:
        </Text>
        {isHtml ? (
          <div dangerouslySetInnerHTML={{ __html: suggestion }} />
        ) : (
          <Text as="p" variant="bodyMd">
            {suggestion}
          </Text>
        )}
        <InlineStack gap="200">
          <Button size="slim" variant="primary" onClick={onAccept}>
            Übernehmen
          </Button>
          <Button size="slim" onClick={onAcceptAndTranslate}>
            Übernehmen & Übersetzen
          </Button>
          <Button size="slim" onClick={onReject}>
            Ablehnen
          </Button>
        </InlineStack>
      </BlockStack>
    </div>
  );
}
