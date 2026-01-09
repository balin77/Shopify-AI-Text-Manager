import { BlockStack, InlineStack, Text, Button } from "@shopify/polaris";

interface AISuggestionBannerProps {
  fieldType: string;
  suggestionText: string;
  isHtml?: boolean;
  onAccept: () => void;
  onDecline: () => void;
  acceptLabel: string;
  declineLabel: string;
  titleLabel: string;
}

export function AISuggestionBanner({
  fieldType,
  suggestionText,
  isHtml = false,
  onAccept,
  onDecline,
  acceptLabel,
  declineLabel,
  titleLabel
}: AISuggestionBannerProps) {
  return (
    <div
      style={{
        marginTop: "0.5rem",
        padding: "1rem",
        background: "#f0f9ff",
        border: "1px solid #0891b2",
        borderRadius: "8px"
      }}
    >
      <BlockStack gap="300">
        <Text as="p" variant="bodyMd" fontWeight="semibold">
          {titleLabel}
        </Text>
        {isHtml ? (
          <div dangerouslySetInnerHTML={{ __html: suggestionText }} />
        ) : (
          <Text as="p" variant="bodyMd">
            {suggestionText}
          </Text>
        )}
        <InlineStack gap="200">
          <Button size="slim" variant="primary" onClick={onAccept}>
            {acceptLabel}
          </Button>
          <Button size="slim" onClick={onDecline}>
            {declineLabel}
          </Button>
        </InlineStack>
      </BlockStack>
    </div>
  );
}
