import { Text, BlockStack, InlineStack, Button } from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";

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
  const { t } = useI18n();

  // Calculate character count (strip HTML tags for accurate count)
  const charCount = isHtml
    ? suggestion.replace(/<[^>]*>/g, '').length
    : suggestion.length;

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
          {t.products.aiSuggestion}
        </Text>
        {isHtml ? (
          <div dangerouslySetInnerHTML={{ __html: suggestion }} />
        ) : (
          <Text as="p" variant="bodyMd">
            {suggestion}
          </Text>
        )}
        <InlineStack gap="200" align="space-between" blockAlign="center">
          <InlineStack gap="200">
            <Button size="slim" variant="primary" onClick={onAccept}>
              {t.products.accept}
            </Button>
            <Button size="slim" onClick={onAcceptAndTranslate}>
              {t.products.acceptTranslate}
            </Button>
            <Button size="slim" onClick={onReject}>
              {t.products.decline}
            </Button>
          </InlineStack>
          <Text as="p" variant="bodySm" tone="subdued">
            {charCount} {t.products.characters}
          </Text>
        </InlineStack>
      </BlockStack>
    </div>
  );
}
