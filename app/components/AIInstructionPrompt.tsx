import { useEffect, useRef, useState } from "react";
import { BlockStack, Button, InlineStack, Text, TextField } from "@shopify/polaris";
import { AI_USER_INSTRUCTION_MAX_LENGTH } from "../config/constants";
import { useI18n } from "../contexts/I18nContext";

interface AIInstructionPromptProps {
  /**
   * Fired with the typed instruction — an empty box submits `undefined`, which
   * every caller must treat as "generate exactly as before".
   */
  onSubmit: (userInstruction?: string) => void;
  onCancel: () => void;
  /** Shown while the generation this box started is still running. */
  isLoading?: boolean;
}

/**
 * The box that opens between the field and its action row when the merchant
 * clicks "Improve/Generate with AI". It is the counterpart of
 * AISuggestionBanner: the suggestion banner ends the AI round trip, this one
 * starts it.
 *
 * Submitting it empty is the documented path back to the previous one-click
 * behaviour, so "Generate" is never disabled on an empty input.
 */
export function AIInstructionPrompt({ onSubmit, onCancel, isLoading = false }: AIInstructionPromptProps) {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);

  // Focus the input as the box opens — the merchant clicked the button to type
  // something, so a second click into the field is pure friction.
  useEffect(() => {
    const input = containerRef.current?.querySelector("textarea, input");
    if (input instanceof HTMLElement) input.focus();
  }, []);

  const submit = () => {
    const trimmed = instruction.trim();
    onSubmit(trimmed || undefined);
  };

  return (
    <div
      ref={containerRef}
      style={{
        marginTop: "0.5rem",
        padding: "1rem",
        background: "#f7f4ff",
        border: "1px solid #8c6ae0",
        borderRadius: "8px",
      }}
      onKeyDown={(e) => {
        // Enter submits (Shift+Enter keeps a line break), Escape closes —
        // the box is a mini dialog, not a content field.
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          if (!isLoading) submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <BlockStack gap="300">
        <Text as="p" variant="bodyMd" fontWeight="semibold">
          {t.products?.aiInstructionTitle || "Instructions for the AI (optional)"}
        </Text>
        <TextField
          label={t.products?.aiInstructionTitle || "Instructions for the AI (optional)"}
          labelHidden
          value={instruction}
          onChange={setInstruction}
          multiline={2}
          autoComplete="off"
          maxLength={AI_USER_INSTRUCTION_MAX_LENGTH}
          placeholder={
            t.products?.aiInstructionPlaceholder ||
            "e.g. Emphasize the wool quality and keep the tone factual"
          }
          helpText={
            t.products?.aiInstructionHelp ||
            "Leave empty to generate as usual. What you enter here takes priority over all other AI rules and settings."
          }
        />
        <InlineStack gap="200">
          <Button size="slim" variant="primary" onClick={submit} loading={isLoading}>
            ✨ {t.products?.aiInstructionSubmit || "Generate"}
          </Button>
          <Button size="slim" onClick={onCancel} disabled={isLoading}>
            {t.common?.cancel || "Cancel"}
          </Button>
        </InlineStack>
      </BlockStack>
    </div>
  );
}
