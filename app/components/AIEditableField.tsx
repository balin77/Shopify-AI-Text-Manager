import { useEffect, useState } from "react";
import { TextField, Button } from "@shopify/polaris";
import { AIInstructionPrompt } from "./AIInstructionPrompt";
import { AISuggestionBanner } from "./AISuggestionBanner";
import { FieldClearOverlay, FieldLabel } from "./unified/FieldChrome";
import { DisabledActionTooltip } from "./DisabledActionTooltip";
import { ActionTooltip } from "./ActionTooltip";
import { aiActionTooltip } from "../utils/ai-action-tooltip";
import { useI18n } from "../contexts/I18nContext";
import { useSingleLocaleHint } from "../contexts/LocaleAvailabilityContext";
import "../styles/AIEditableField.css";

interface AIEditableFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  fieldType: string;
  fieldKey?: string;
  suggestion?: string;
  isPrimaryLocale: boolean;
  isTranslated?: boolean;
  helpText?: string;
  /** Key for help tooltip content from translations (e.g., "title", "description") */
  helpKey?: string;
  multiline?: number;
  maxLength?: number;
  placeholder?: string;
  isLoading?: boolean;
  isDataLoading?: boolean;
  sourceTextAvailable?: boolean;
  hasMissingTranslations?: boolean;
  hasFieldMissingTranslations?: boolean;
  /** If true, only "Improve with AI" is shown (disabled when empty). Used for templates. */
  disableGeneration?: boolean;
  /** If true, the value is a fallback from primary locale (shown in gray) */
  isFallbackValue?: boolean;
  /** If true, the field is read-only (disabled). Used when primary locale template editing is not enabled. */
  readOnly?: boolean;
  /**
   * Identity of what this field currently edits (item + locale). The component
   * is reused across items/locales instead of remounted, so an open AI
   * instruction box would otherwise survive the switch and apply the text
   * written for one target to another. Changing this closes the box.
   */
  aiPromptScopeKey?: string;
  /** If true, show required indicator (red asterisk) */
  requiredIndicator?: boolean;
  /** Suffix appended by Shopify (e.g. " – Shop Name"). Displayed inside the field non-editable, and counted in char limit. */
  seoSuffix?: string;
  /** Error message shown below the field (e.g. when AI translation fails due to text being too long) */
  error?: string;
  /**
   * Runs the generation. The argument is the merchant's ad-hoc instruction from
   * the AIInstructionPrompt box — `undefined` when the box was submitted empty,
   * which must behave exactly like the old one-click generation.
   */
  onGenerateAI?: (userInstruction?: string) => void;
  onFormatAI?: () => void;
  onTranslate?: () => void;
  onTranslateToAllLocales?: () => void;
  onCopy?: () => void;
  onCopyToAllLocales?: () => void;
  onAcceptSuggestion?: () => void;
  onAcceptAndTranslate?: () => void;
  onRejectSuggestion?: () => void;
  onClear?: () => void;
}

export function AIEditableField({
  label,
  value,
  onChange,
  fieldType,
  fieldKey,
  suggestion,
  isPrimaryLocale,
  isTranslated = true,
  helpText,
  helpKey,
  multiline,
  maxLength,
  placeholder,
  isLoading = false,
  isDataLoading = false,
  sourceTextAvailable = true,
  hasMissingTranslations = false,
  hasFieldMissingTranslations,
  disableGeneration = false,
  isFallbackValue = false,
  readOnly = false,
  requiredIndicator = false,
  aiPromptScopeKey,
  seoSuffix,
  error,
  onGenerateAI,
  onFormatAI,
  onTranslate,
  onTranslateToAllLocales,
  onCopy,
  onCopyToAllLocales,
  onAcceptSuggestion,
  onAcceptAndTranslate,
  onRejectSuggestion,
  onClear,
}: AIEditableFieldProps) {
  const { t } = useI18n();
  // Set in a single-language shop: translating / copying to "all locales" has no
  // target, so those buttons are greyed out with this as their tooltip.
  const singleLocaleHint = useSingleLocaleHint();
  // The generate button no longer fires straight away: it opens the instruction
  // box first, which then calls onGenerateAI (with or without an instruction).
  const [instructionPromptOpen, setInstructionPromptOpen] = useState(false);
  // Drop an open box (and the text in it) when the field switches target —
  // another gallery image (fieldKey), another item or locale (scope key).
  useEffect(() => {
    setInstructionPromptOpen(false);
  }, [fieldKey, aiPromptScopeKey]);

  // Determine background color class based on translation state
  const getBackgroundClass = () => {
    // During initial data loading, show white to prevent flash
    if (isDataLoading) return "bg-white";

    // Priority 1: AI suggestion is active (light blue)
    if (suggestion) return "bg-suggestion";

    // Priority 2: Primary locale is empty (orange)
    if (isPrimaryLocale && !value) return "bg-untranslated";

    // Priority 3: Primary locale has content but THIS FIELD has missing translations (blue)
    // Use field-specific check if provided, otherwise fall back to global check
    const fieldHasMissingTranslations = hasFieldMissingTranslations !== undefined
      ? hasFieldMissingTranslations
      : hasMissingTranslations;

    if (isPrimaryLocale && value && fieldHasMissingTranslations) return "bg-missing-translation";

    // Priority 4: Fallback value (gray) - works for both primary and foreign locales
    // Example: SEO Title field using Product Title as fallback
    if (isFallbackValue) return "bg-fallback";

    // Priority 5: Foreign locale - orange if not translated, white if translated
    if (!isPrimaryLocale) {
      return isTranslated ? "bg-white" : "bg-untranslated";
    }

    // Default: White for primary locale with content
    return "bg-white";
  };

  return (
    <div>
      {/* The clear button and the bold, question-marked label are the SHARED
          field chrome now (FieldChrome.tsx) — this component drew both by hand,
          and every control that did not go through it looked different in the
          same card. */}
      <FieldClearOverlay onClear={onClear} hasValue={!!value}>
        <div className={`ai-editable-field-wrapper ${getBackgroundClass()}`}>
          <TextField
            label={<FieldLabel label={label} helpKey={helpKey} requiredIndicator={requiredIndicator} />}
            value={value}
            onChange={onChange}
            disabled={readOnly}
            autoComplete="off"
            helpText={helpText}
            multiline={multiline}
            maxLength={maxLength}
            placeholder={placeholder}
            showCharacterCount={!!maxLength}
            error={error}
            suffix={seoSuffix ? (
              <span style={{ color: "#6d7175", whiteSpace: "nowrap" }}>{seoSuffix}</span>
            ) : undefined}
          />
        </div>
      </FieldClearOverlay>

      {instructionPromptOpen && onGenerateAI && (
        <AIInstructionPrompt
          isLoading={isLoading}
          onSubmit={(userInstruction) => {
            setInstructionPromptOpen(false);
            onGenerateAI(userInstruction);
          }}
          onCancel={() => setInstructionPromptOpen(false)}
        />
      )}

      {suggestion && onAcceptSuggestion && onRejectSuggestion && (
        <AISuggestionBanner
          fieldType={fieldType}
          suggestionText={suggestion}
          isHtml={false}
          onAccept={onAcceptSuggestion}
          onDecline={onRejectSuggestion}
          onAcceptAndTranslate={onAcceptAndTranslate}
          acceptLabel={t.products?.accept || "Accept"}
          declineLabel={t.products?.decline || "Decline"}
          acceptAndTranslateLabel={onAcceptAndTranslate ? (t.products?.acceptTranslate || "Accept & Translate") : undefined}
          titleLabel={t.products?.aiSuggestion || "AI suggestion:"}
        />
      )}

      <div className="ai-field-footer">
        <div className="ai-field-footer-right">
          {onGenerateAI && (
            <ActionTooltip
              content={aiActionTooltip(t, "generate", { hasValue: !!value, disableGeneration })}
              disabled={(disableGeneration && !value) || isLoading}
            >
              <Button
                size="slim"
                onClick={() => setInstructionPromptOpen((open) => !open)}
                pressed={instructionPromptOpen}
                loading={isLoading}
                disabled={(disableGeneration && !value) || isLoading}
              >
                ✨ {disableGeneration || value
                  ? (t.products?.aiImprove || "Improve with AI")
                  : (t.products?.aiGenerateShort || "Generate with AI")}
              </Button>
            </ActionTooltip>
          )}
          {onFormatAI && (
            <ActionTooltip
              content={aiActionTooltip(t, "format", { hasValue: !!value, disableGeneration })}
              disabled={!value || isLoading}
            >
              <Button
                size="slim"
                onClick={onFormatAI}
                loading={isLoading}
                disabled={!value || isLoading}
              >
                🎨 {t.products?.formatWithAI || "Format"}
              </Button>
            </ActionTooltip>
          )}
          {(onTranslate || onTranslateToAllLocales) && (
            <DisabledActionTooltip hint={singleLocaleHint}>
              <Button
                size="slim"
                onClick={isPrimaryLocale ? (onTranslateToAllLocales || onTranslate) : onTranslate}
                loading={isLoading}
                disabled={(isPrimaryLocale ? (!onTranslateToAllLocales && !onTranslate) : !sourceTextAvailable) || isLoading || !!singleLocaleHint}
              >
                🌍 {isPrimaryLocale ? (t.products?.translate || "Translate") : t.products?.translateFromPrimary}
              </Button>
            </DisabledActionTooltip>
          )}
          {(onCopy || onCopyToAllLocales) && (
            <DisabledActionTooltip hint={singleLocaleHint}>
              <Button
                size="slim"
                onClick={isPrimaryLocale ? onCopyToAllLocales : onCopy}
                loading={isLoading}
                disabled={(isPrimaryLocale ? (!value || isLoading) : (!sourceTextAvailable || isLoading)) || !!singleLocaleHint}
              >
                📋 {isPrimaryLocale
                  ? (t.products?.copyToAllLocales || "Copy to all")
                  : (t.products?.copy || "Copy")}
              </Button>
            </DisabledActionTooltip>
          )}
        </div>
      </div>
    </div>
  );
}
