import { useState, useEffect } from "react";
import { BlockStack, Text, Button, InlineStack, Card, TextField, ChoiceList, Banner } from "@shopify/polaris";
import { AIInstructionFieldGroup } from "./AIInstructionFieldGroup";
import { SaveDiscardButtons } from "./SaveDiscardButtons";
import { ToggleSwitch } from "./ToggleSwitch";
import { HelpTooltip } from "./HelpTooltip";
import { SettingsGlossaryTab, type GlossaryEntryDto, type GlossaryShopLocale } from "./SettingsGlossaryTab";
import {
  getDefaultInstructions,
  getDefaultForField,
  DEFAULT_GENERAL_INSTRUCTIONS,
  type EntityType
} from "../constants/aiInstructionsDefaults";
import type { FetcherWithComponents } from "react-router";
import { useI18n } from "../contexts/I18nContext";
import { meetsPlan, type Plan } from "../utils/planUtils";
import { PLAN_DISPLAY_NAMES } from "../config/plans";
import { AUTO_TRANSLATE_MIN_PLAN } from "../services/translations/translation-change-policy.shared";

interface Instructions {
  // General (Writing Style Instructions)
  writingStyleInstructions: string;
  // General (Format Instructions)
  formatPreserveInstructions: string;
  // General (Translate Instructions)
  translateInstructions: string;

  // Products
  productTitleFormat: string;
  productTitleInstructions: string;
  productDescriptionFormat: string;
  productDescriptionInstructions: string;
  productHandleFormat: string;
  productHandleInstructions: string;
  productSeoTitleFormat: string;
  productSeoTitleInstructions: string;
  productMetaDescFormat: string;
  productMetaDescInstructions: string;
  productAltTextFormat: string;
  productAltTextInstructions: string;

  // Collections
  collectionTitleFormat: string;
  collectionTitleInstructions: string;
  collectionDescriptionFormat: string;
  collectionDescriptionInstructions: string;
  collectionHandleFormat: string;
  collectionHandleInstructions: string;
  collectionSeoTitleFormat: string;
  collectionSeoTitleInstructions: string;
  collectionMetaDescFormat: string;
  collectionMetaDescInstructions: string;

  // Blogs
  blogTitleFormat: string;
  blogTitleInstructions: string;
  blogDescriptionFormat: string;
  blogDescriptionInstructions: string;
  blogHandleFormat: string;
  blogHandleInstructions: string;
  blogSeoTitleFormat: string;
  blogSeoTitleInstructions: string;
  blogMetaDescFormat: string;
  blogMetaDescInstructions: string;

  // Pages
  pageTitleFormat: string;
  pageTitleInstructions: string;
  pageDescriptionFormat: string;
  pageDescriptionInstructions: string;
  pageHandleFormat: string;
  pageHandleInstructions: string;
  pageSeoTitleFormat: string;
  pageSeoTitleInstructions: string;
  pageMetaDescFormat: string;
  pageMetaDescInstructions: string;

  // Policies
  policyDescriptionFormat: string;
  policyDescriptionInstructions: string;
}

interface AIInstructionsTabsProps {
  instructions: Instructions;
  fetcher: FetcherWithComponents<any>;
  readOnly?: boolean;
  onHasChangesChange?: (hasChanges: boolean) => void;
  // Glossary — rendered inside the "Übersetzungen" sub-section.
  glossaryEntries: GlossaryEntryDto[];
  shopLocales: GlossaryShopLocale[];
  primaryShopLocale: string;
  onGlossaryHasChangesChange?: (hasChanges: boolean) => void;
  // AISettings.translationMode — "exact" preserves source length,
  // "seo_optimized" tells the AI to paraphrase within SEO caps. Saved as part
  // of the same "saveInstructions" submit so a single button covers the
  // entire Translations sub-section.
  translationMode: "exact" | "seo_optimized";
  /**
   * AISettings.keywordAwareTranslation — whether a translation is phrased so
   * the TARGET locale's own tracked keyword survives, instead of being a
   * literal rendering of the primary text.
   */
  keywordAwareTranslation: boolean;
  /**
   * AISettings.translationPurgeOnPrimaryChange — whether a changed or CLEARED
   * primary value deletes its foreign translations (everywhere: both editors,
   * and the sync that notices a change made outside this app).
   */
  translationPurgeOnPrimaryChange: boolean;
  /**
   * AISettings.autoTranslateExternalChanges (Max) — re-translate instead of
   * only deleting when the primary text changed OUTSIDE this app.
   */
  autoTranslateExternalChanges: boolean;
  /** Drives the Max gate on the auto-translate switch. */
  subscriptionPlan: Plan;
}

export function AIInstructionsTabs({
  instructions,
  fetcher,
  readOnly = false,
  onHasChangesChange,
  glossaryEntries,
  shopLocales,
  primaryShopLocale,
  onGlossaryHasChangesChange,
  translationMode,
  keywordAwareTranslation,
  translationPurgeOnPrimaryChange,
  autoTranslateExternalChanges,
  subscriptionPlan,
}: AIInstructionsTabsProps) {
  const { t } = useI18n();
  const [subSection, setSubSection] = useState<"content" | "translations">("content");
  const [selectedTab, setSelectedTab] = useState(0);
  const [localInstructions, setLocalInstructions] = useState<Instructions>(instructions);
  const [localTranslationMode, setLocalTranslationMode] = useState<"exact" | "seo_optimized">(translationMode);
  const [localKeywordAware, setLocalKeywordAware] = useState(keywordAwareTranslation);
  const [localPurgeOnChange, setLocalPurgeOnChange] = useState(translationPurgeOnPrimaryChange);
  const [localAutoTranslateExternal, setLocalAutoTranslateExternal] = useState(
    autoTranslateExternalChanges,
  );
  // The auto-translate switch stays VISIBLE on every plan (hiding it would
  // read as "this app cannot do that") and is greyed out below Max, with the
  // required tier named underneath.
  const canAutoTranslateExternal = meetsPlan(subscriptionPlan, AUTO_TRANSLATE_MIN_PLAN);
  const [htmlModes, setHtmlModes] = useState<Record<string, "html" | "rendered">>({});

  const tabs = [
    {
      id: 'general',
      content: t.settings.tabGeneral || 'General',
      panelID: 'general-panel',
    },
    {
      id: 'products',
      content: t.settings.tabProducts,
      panelID: 'products-panel',
    },
    {
      id: 'collections',
      content: t.settings.tabCollections,
      panelID: 'collections-panel',
    },
    {
      id: 'blogs',
      content: t.settings.tabBlogs,
      panelID: 'blogs-panel',
    },
    {
      id: 'pages',
      content: t.settings.tabPages,
      panelID: 'pages-panel',
    },
    {
      id: 'policies',
      content: t.settings.tabPolicies,
      panelID: 'policies-panel',
    },
  ];

  const currentEntityType = tabs[selectedTab].id as EntityType;

  const handleFieldChange = (field: string, value: string) => {
    if (readOnly) return; // Prevent changes in read-only mode
    setLocalInstructions({ ...localInstructions, [field]: value });
  };

  // Map full field names (e.g., 'productTitleFormat') to EntityInstructions keys (e.g., 'titleFormat')
  const getEntityFieldName = (fullFieldName: string, entityType: EntityType): string => {
    const prefix = entityType === 'products' ? 'product' :
                   entityType === 'collections' ? 'collection' :
                   entityType === 'blogs' ? 'blog' :
                   entityType === 'pages' ? 'page' : 'policy';

    // Remove prefix to get the field name: 'productTitleFormat' -> 'TitleFormat'
    const withoutPrefix = fullFieldName.replace(new RegExp(`^${prefix}`, 'i'), '');

    // Lowercase first letter: 'TitleFormat' -> 'titleFormat'
    return withoutPrefix.charAt(0).toLowerCase() + withoutPrefix.slice(1);
  };

  const handleResetFormatField = (formatField: string, entityType: EntityType) => {
    const entityFieldName = getEntityFieldName(formatField, entityType);
    const defaultValue = getDefaultForField(entityType, entityFieldName as any);
    setLocalInstructions({ ...localInstructions, [formatField]: defaultValue });
  };

  const handleResetInstructionsField = (instructionsField: string, entityType: EntityType) => {
    const entityFieldName = getEntityFieldName(instructionsField, entityType);
    const defaultValue = getDefaultForField(entityType, entityFieldName as any);
    setLocalInstructions({ ...localInstructions, [instructionsField]: defaultValue });
  };

  const handleResetAll = () => {
    const defaults = getDefaultInstructions(currentEntityType);
    setLocalInstructions({ ...localInstructions, ...defaults });
  };

  const handleSave = () => {
    const formData = new FormData();
    formData.append("actionType", "saveInstructions");

    // Add all instruction fields to FormData
    Object.entries(localInstructions).forEach(([key, value]) => {
      formData.append(key, value);
    });

    // Translation mode piggybacks on the same save so one button covers the
    // entire Translations sub-section (radio + custom instructions).
    formData.append("translationMode", localTranslationMode);
    formData.append("keywordAwareTranslation", String(localKeywordAware));
    formData.append("translationPurgeOnPrimaryChange", String(localPurgeOnChange));
    // Never claim the Max feature from a plan that cannot have it: the server
    // rejects a change it is not entitled to, and sending the STORED value
    // keeps an unentitled save from tripping that gate.
    formData.append(
      "autoTranslateExternalChanges",
      String(canAutoTranslateExternal ? localAutoTranslateExternal : autoTranslateExternalChanges),
    );

    fetcher.submit(formData, { method: "POST" });
  };

  const handleToggleHtmlMode = (fieldName: string) => {
    setHtmlModes((prev) => ({
      ...prev,
      [fieldName]: prev[fieldName] === "html" ? "rendered" : "html",
    }));
  };

  // Check if there are unsaved changes (instructions OR translation mode)
  const hasChanges =
    JSON.stringify(localInstructions) !== JSON.stringify(instructions) ||
    localTranslationMode !== translationMode ||
    localKeywordAware !== keywordAwareTranslation ||
    localPurgeOnChange !== translationPurgeOnPrimaryChange ||
    (canAutoTranslateExternal && localAutoTranslateExternal !== autoTranslateExternalChanges);

  // Propagate hasChanges to parent component
  useEffect(() => {
    if (onHasChangesChange) {
      onHasChangesChange(hasChanges);
    }
  }, [hasChanges, onHasChangesChange]);

  const handleDiscard = () => {
    setLocalInstructions(instructions);
    setLocalTranslationMode(translationMode);
    setLocalKeywordAware(keywordAwareTranslation);
    setLocalPurgeOnChange(translationPurgeOnPrimaryChange);
    setLocalAutoTranslateExternal(autoTranslateExternalChanges);
  };

  return (
    <BlockStack gap="400">
    <Card>
      <BlockStack gap="500">
        {/* Header with Title and Save/Discard Buttons */}
        <InlineStack align="space-between" blockAlign="center" wrap={false}>
          <Text as="h2" variant="headingLg">
            {t.settings.aiInstructions}
          </Text>
          {!readOnly && (
            <SaveDiscardButtons
              hasChanges={hasChanges}
              onSave={handleSave}
              onDiscard={handleDiscard}
              saveText={t.products?.saveChanges || "Änderungen speichern"}
              discardText={t.content?.discardChanges || "Verwerfen"}
              action="saveInstructions"
              fetcherState={fetcher.state}
              fetcherFormData={fetcher.formData}
            />
          )}
        </InlineStack>

        {/* Description */}
        <Text as="p" variant="bodyMd" tone="subdued">
          {readOnly
            ? t.settings.defaultInstructionsReadOnly
            : t.settings.aiInstructionsDescription
          }
        </Text>

        {/* Top-level sub-section switch: "Inhalte erstellen" | "Übersetzungen".
            Content generation shows the entity tab strip; translations shows
            only the Translate Instructions block (and Glossary below the card). */}
        <div style={{ borderBottom: "1px solid #e1e3e5" }}>
          <InlineStack gap="0">
            {(["content", "translations"] as const).map((section) => {
              const isActive = subSection === section;
              const label = section === "content"
                ? (t.settings.subtabContentGeneration || "Inhalte erstellen")
                : (t.settings.subtabTranslations || "Übersetzungen");
              return (
                <button
                  key={section}
                  onClick={() => setSubSection(section)}
                  style={{
                    padding: "0.75rem 1.25rem",
                    background: "none",
                    border: "none",
                    borderBottom: isActive ? "3px solid #008060" : "3px solid transparent",
                    marginBottom: "-1px",
                    cursor: "pointer",
                  }}
                >
                  <Text
                    as="span"
                    variant="bodyMd"
                    fontWeight={isActive ? "bold" : "regular"}
                    tone={isActive ? "base" : "subdued"}
                  >
                    {label}
                  </Text>
                </button>
              );
            })}
          </InlineStack>
        </div>

        {/* Custom Tab Navigation — only visible in "content" sub-section */}
        {subSection === "content" && (
        <div style={{
          background: "#f6f6f7",
          borderRadius: "8px",
          padding: "1rem",
          borderBottom: "1px solid #e1e3e5",
        }}>
        <InlineStack gap="400">
          {tabs.map((tab, index) => {
            const isActive = selectedTab === index;
            return (
              <button
                key={tab.id}
                onClick={() => setSelectedTab(index)}
                style={{
                  textDecoration: "none",
                  padding: "1rem 0.5rem",
                  transition: "border-color 0.2s",
                  background: "none",
                  border: "none",
                  borderBottom: isActive ? "3px solid #303030" : "3px solid transparent",
                  cursor: "pointer",
                }}
              >
                <Text
                  as="span"
                  variant="bodyMd"
                  fontWeight={isActive ? "bold" : "regular"}
                  tone="base"
                >
                  {tab.content}
                </Text>
              </button>
            );
          })}
        </InlineStack>
      </div>
      )}

      {/* Tab Content */}
      <div style={{ opacity: readOnly ? 0.6 : 1, pointerEvents: readOnly ? "none" : "auto" }}>
        <BlockStack gap="400" inlineAlign="stretch">
            {/* TRANSLATIONS SUB-SECTION — mode picker + Translate Instructions block */}
            {subSection === "translations" && (
              <BlockStack gap="400">
              <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                <BlockStack gap="400">
                  <InlineStack gap="100" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {t.settings.translationModeLabel || 'Übersetzungsstrategie'}
                    </Text>
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.settings.translationModeDescription ||
                      'Steuert, wie die KI Übersetzungen an die SEO-Zeichenlimits anpasst. Die Limits selbst pflegst du unter SEO.'}
                  </Text>
                  <ChoiceList
                    title={t.settings.translationModeLabel || 'Übersetzungsstrategie'}
                    titleHidden
                    selected={[localTranslationMode]}
                    onChange={(selected) => {
                      const next = selected[0];
                      if (next === 'exact' || next === 'seo_optimized') {
                        setLocalTranslationMode(next);
                      }
                    }}
                    disabled={readOnly}
                    choices={[
                      {
                        label: t.settings.translationModeExact || 'Exakte Übersetzung (empfohlen)',
                        value: 'exact',
                        helpText:
                          t.settings.translationModeExactHelp ||
                          'Der Ausgangstext wird 1:1 übersetzt. Länge bleibt erhalten — wichtig für Rechtstexte, AGB, Widerruf.',
                      },
                      {
                        label: t.settings.translationModeSeo || 'SEO-optimierte Übersetzung',
                        value: 'seo_optimized',
                        helpText:
                          t.settings.translationModeSeoHelp ||
                          'Bei SEO-Titel, Meta-Beschreibung, Titel und Alt-Text darf die KI kürzen/umschreiben, um die SEO-Limits einzuhalten. Bodies bleiben unverändert.',
                      },
                    ]}
                  />
                  {localTranslationMode === 'seo_optimized' && (
                    <Banner tone="info">
                      <Text as="p" variant="bodySm">
                        {t.settings.translationModeSeoNote ||
                          'Aktiv nur für SEO-kritische Felder. Beschreibungen/Bodies werden weiterhin exakt übersetzt.'}
                      </Text>
                    </Banner>
                  )}
                </BlockStack>
              </div>
              {/* Keyword-aware translation. Sits between the strategy picker
                  and the free-text instructions because it is the same kind of
                  knob: it changes HOW the AI translates, not what it is told
                  about the shop. Saved with the rest of this tab. */}
              <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                <BlockStack gap="300">
                  <Text as="h3" variant="headingMd">
                    {t.settings.keywordAwareTranslation}
                  </Text>
                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <ToggleSwitch
                      checked={localKeywordAware}
                      onChange={setLocalKeywordAware}
                      disabled={readOnly}
                    />
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.settings.keywordAwareTranslationHelp}
                    </Text>
                  </InlineStack>
                </BlockStack>
              </div>
              {/* What happens to a translation when its SOURCE text changes.
                  Two switches, one card: the first decides whether the stale
                  translation is dropped at all, the second (Max) whether a
                  change made OUTSIDE this app is translated again right away.
                  They sit together because a merchant reasons about them
                  together — "what does the app do when the German text
                  changes?" */}
              <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                <BlockStack gap="400">
                  <Text as="h3" variant="headingMd">
                    {t.settings.translationChangeHeading || 'Bei Änderung der Hauptsprache'}
                  </Text>

                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <ToggleSwitch
                      checked={localPurgeOnChange}
                      onChange={setLocalPurgeOnChange}
                      disabled={readOnly}
                    />
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd">
                        {t.settings.translationPurgeOnPrimaryChange ||
                          'Übersetzungen löschen, wenn der Text in der Hauptsprache geändert oder gelöscht wird'}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.settings.translationPurgeOnPrimaryChangeHelp ||
                          'Eine Übersetzung eines Textes, den es so nicht mehr gibt, wird sonst weiter im Shop ausgeliefert. Aus: Die alten Übersetzungen bleiben stehen und Shopify markiert sie in seinem eigenen Übersetzungs-Editor als veraltet.'}
                      </Text>
                    </BlockStack>
                  </InlineStack>

                  <InlineStack gap="300" blockAlign="center" wrap={false}>
                    <ToggleSwitch
                      checked={canAutoTranslateExternal && localAutoTranslateExternal}
                      onChange={setLocalAutoTranslateExternal}
                      disabled={readOnly || !canAutoTranslateExternal}
                    />
                    <BlockStack gap="100">
                      <Text as="p" variant="bodyMd">
                        {t.settings.autoTranslateExternalChanges ||
                          'Texte automatisch neu übersetzen, wenn sie ausserhalb der App geändert werden'}
                      </Text>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.settings.autoTranslateExternalChangesHelp ||
                          'Wird ein Text im Shopify-Admin, in einer anderen App oder per Import geändert, übersetzt die KI ihn beim nächsten Sync sofort neu — statt die veraltete Übersetzung nur zu löschen. URL-Handles bleiben ausgenommen.'}
                      </Text>
                      {!canAutoTranslateExternal && (
                        <Text as="p" variant="bodySm" tone="subdued">
                          {(t.settings.autoTranslateExternalChangesPlanHint ||
                            'Ab dem {plan}-Plan verfügbar.').replace(
                            '{plan}',
                            PLAN_DISPLAY_NAMES[AUTO_TRANSLATE_MIN_PLAN],
                          )}
                        </Text>
                      )}
                    </BlockStack>
                  </InlineStack>
                </BlockStack>
              </div>
              <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                <BlockStack gap="400">
                  <InlineStack gap="100" blockAlign="center">
                    <Text as="h3" variant="headingMd">
                      {t.settings.translateInstructionsLabel || 'Translate Instructions'}
                    </Text>
                    <HelpTooltip helpKey="translateInstructions" />
                  </InlineStack>
                  <div>
                    <InlineStack align="space-between" blockAlign="center">
                      <Text as="p" variant="bodyMd" fontWeight="medium">
                        {t.settings.instructionsLabel || 'Instructions'}
                      </Text>
                      <Button
                        size="slim"
                        onClick={() => handleFieldChange('translateInstructions', DEFAULT_GENERAL_INSTRUCTIONS.translateInstructions)}
                        tone="critical"
                        variant="plain"
                      >
                        {t.settings?.resetField || "Reset"}
                      </Button>
                    </InlineStack>
                    <TextField
                      label=""
                      value={localInstructions.translateInstructions || ''}
                      onChange={(v) => handleFieldChange('translateInstructions', v)}
                      multiline={8}
                      placeholder={t.settings.translateInstructionsPlaceholder || 'Instructions for the Translate function...'}
                      helpText={`${(localInstructions.translateInstructions || '').length} ${t.products.characters}`}
                      autoComplete="off"
                    />
                  </div>
                </BlockStack>
              </div>
              </BlockStack>
            )}

            {/* CONTENT GENERATION SUB-SECTION — original entity tabs */}
            {subSection === "content" && selectedTab === 0 && (
              <>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {t.settings.generalTabDescription || 'These instructions control how the "Format" function behaves. The Format function preserves your original text and only applies formatting changes.'}
                </Text>

                {/* Writing Style Instructions */}
                <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                  <BlockStack gap="400">
                    <InlineStack gap="100" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        {t.settings.writingStyleInstructionsLabel || 'Writing Style'}
                      </Text>
                      <HelpTooltip helpKey="writingStyleInstructions" />
                    </InlineStack>
                    <div>
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {t.settings.instructionsLabel || 'Instructions'}
                        </Text>
                        <Button
                          size="slim"
                          onClick={() => handleFieldChange('writingStyleInstructions', DEFAULT_GENERAL_INSTRUCTIONS.writingStyleInstructions)}
                          tone="critical"
                          variant="plain"
                        >
                          {t.settings?.resetField || "Reset"}
                        </Button>
                      </InlineStack>
                      <TextField
                        label=""
                        value={localInstructions.writingStyleInstructions || ''}
                        onChange={(v) => handleFieldChange('writingStyleInstructions', v)}
                        multiline={8}
                        placeholder={t.settings.writingStyleInstructionsPlaceholder || 'Instructions for writing style...'}
                        helpText={`${(localInstructions.writingStyleInstructions || '').length} ${t.products.characters}`}
                        autoComplete="off"
                      />
                    </div>
                  </BlockStack>
                </div>

                {/* Format Instructions */}
                <div style={{ padding: "1rem", background: "#f6f6f7", borderRadius: "8px" }}>
                  <BlockStack gap="400">
                    <InlineStack gap="100" blockAlign="center">
                      <Text as="h3" variant="headingMd">
                        {t.settings.formatPreserveInstructionsLabel || 'Format Instructions'}
                      </Text>
                      <HelpTooltip helpKey="formatInstructions" />
                    </InlineStack>
                    <div>
                      <InlineStack align="space-between" blockAlign="center">
                        <Text as="p" variant="bodyMd" fontWeight="medium">
                          {t.settings.instructionsLabel || 'Instructions'}
                        </Text>
                        <Button
                          size="slim"
                          onClick={() => handleFieldChange('formatPreserveInstructions', DEFAULT_GENERAL_INSTRUCTIONS.formatPreserveInstructions)}
                          tone="critical"
                          variant="plain"
                        >
                          {t.settings?.resetField || "Reset"}
                        </Button>
                      </InlineStack>
                      <TextField
                        label=""
                        value={localInstructions.formatPreserveInstructions || ''}
                        onChange={(v) => handleFieldChange('formatPreserveInstructions', v)}
                        multiline={8}
                        placeholder={t.settings.formatPreserveInstructionsPlaceholder || 'Instructions for the Format function...'}
                        helpText={`${(localInstructions.formatPreserveInstructions || '').length} ${t.products.characters}`}
                        autoComplete="off"
                      />
                    </div>
                  </BlockStack>
                </div>
              </>
            )}

            {/* PRODUCTS TAB */}
            {subSection === "content" && selectedTab === 1 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldAltText}
                  formatValue={localInstructions.productAltTextFormat}
                  instructionsValue={localInstructions.productAltTextInstructions}
                  onFormatChange={(v) => handleFieldChange('productAltTextFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productAltTextInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productAltTextFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productAltTextInstructions', 'products')}
                  formatPlaceholder={t.settings.productAltTextFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productAltTextInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.productTitleFormat}
                  instructionsValue={localInstructions.productTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldDescription}
                  formatValue={localInstructions.productDescriptionFormat}
                  instructionsValue={localInstructions.productDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('productDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productDescriptionFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productDescriptionInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['productDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('productDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.productHandleFormat}
                  instructionsValue={localInstructions.productHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('productHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productHandleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productHandleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.productSeoTitleFormat}
                  instructionsValue={localInstructions.productSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('productSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productSeoTitleFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productSeoTitleInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.productMetaDescFormat}
                  instructionsValue={localInstructions.productMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('productMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('productMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('productMetaDescFormat', 'products')}
                  onResetInstructions={() => handleResetInstructionsField('productMetaDescInstructions', 'products')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.productMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.productMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* COLLECTIONS TAB */}
            {subSection === "content" && selectedTab === 2 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.collectionTitleFormat}
                  instructionsValue={localInstructions.collectionTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldDescription}
                  formatValue={localInstructions.collectionDescriptionFormat}
                  instructionsValue={localInstructions.collectionDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionDescriptionFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionDescriptionInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['collectionDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('collectionDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.collectionHandleFormat}
                  instructionsValue={localInstructions.collectionHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionHandleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionHandleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.collectionSeoTitleFormat}
                  instructionsValue={localInstructions.collectionSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionSeoTitleFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionSeoTitleInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.collectionMetaDescFormat}
                  instructionsValue={localInstructions.collectionMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('collectionMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('collectionMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('collectionMetaDescFormat', 'collections')}
                  onResetInstructions={() => handleResetInstructionsField('collectionMetaDescInstructions', 'collections')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.collectionMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.collectionMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* BLOGS TAB */}
            {subSection === "content" && selectedTab === 3 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.blogTitleFormat}
                  instructionsValue={localInstructions.blogTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.blogDescriptionFormat}
                  instructionsValue={localInstructions.blogDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('blogDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogDescriptionFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogDescriptionInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['blogDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('blogDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.blogHandleFormat}
                  instructionsValue={localInstructions.blogHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogHandleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogHandleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldSeoTitle}
                  formatValue={localInstructions.blogSeoTitleFormat}
                  instructionsValue={localInstructions.blogSeoTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('blogSeoTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogSeoTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogSeoTitleFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogSeoTitleInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogSeoTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogSeoTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldMetaDescription}
                  formatValue={localInstructions.blogMetaDescFormat}
                  instructionsValue={localInstructions.blogMetaDescInstructions}
                  onFormatChange={(v) => handleFieldChange('blogMetaDescFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('blogMetaDescInstructions', v)}
                  onResetFormat={() => handleResetFormatField('blogMetaDescFormat', 'blogs')}
                  onResetInstructions={() => handleResetInstructionsField('blogMetaDescInstructions', 'blogs')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.blogMetaDescFormatPlaceholder}
                  instructionsPlaceholder={t.settings.blogMetaDescInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* PAGES TAB */}
            {subSection === "content" && selectedTab === 4 && (
              <>
                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldTitle}
                  formatValue={localInstructions.pageTitleFormat}
                  instructionsValue={localInstructions.pageTitleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageTitleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageTitleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageTitleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageTitleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageTitleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageTitleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.pageDescriptionFormat}
                  instructionsValue={localInstructions.pageDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('pageDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageDescriptionFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageDescriptionInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['pageDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('pageDescriptionFormat')}
                />

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldUrlHandle}
                  formatValue={localInstructions.pageHandleFormat}
                  instructionsValue={localInstructions.pageHandleInstructions}
                  onFormatChange={(v) => handleFieldChange('pageHandleFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('pageHandleInstructions', v)}
                  onResetFormat={() => handleResetFormatField('pageHandleFormat', 'pages')}
                  onResetInstructions={() => handleResetInstructionsField('pageHandleInstructions', 'pages')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.pageHandleFormatPlaceholder}
                  instructionsPlaceholder={t.settings.pageHandleInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                />
              </>
            )}

            {/* POLICIES TAB */}
            {subSection === "content" && selectedTab === 5 && (
              <>
                <Text as="p" variant="bodyMd" tone="subdued">
                  {t.settings.policyNotice}
                </Text>

                <AIInstructionFieldGroup
                  fieldName={t.settings.fieldContent}
                  formatValue={localInstructions.policyDescriptionFormat}
                  instructionsValue={localInstructions.policyDescriptionInstructions}
                  onFormatChange={(v) => handleFieldChange('policyDescriptionFormat', v)}
                  onInstructionsChange={(v) => handleFieldChange('policyDescriptionInstructions', v)}
                  onResetFormat={() => handleResetFormatField('policyDescriptionFormat', 'policies')}
                  onResetInstructions={() => handleResetInstructionsField('policyDescriptionInstructions', 'policies')}
                  resetFormatText={t.settings?.resetField || "Reset"}
                  resetInstructionsText={t.settings?.resetField || "Reset"}
                  formatPlaceholder={t.settings.policyDescriptionFormatPlaceholder}
                  instructionsPlaceholder={t.settings.policyDescriptionInstructionsPlaceholder}
                  formatLabel={t.settings.formatLabel}
                  instructionsLabel={t.settings.instructionsLabel}
                  isHtmlField={true}
                  htmlMode={htmlModes['policyDescriptionFormat'] || 'rendered'}
                  onToggleHtmlMode={() => handleToggleHtmlMode('policyDescriptionFormat')}
                />
              </>
            )}
        </BlockStack>
      </div>

      {/* Reset All Button — only meaningful for the entity-tab strip. */}
      {!readOnly && subSection === "content" && (
        <div style={{ paddingTop: "1rem", borderTop: "1px solid #e1e3e5" }}>
          <InlineStack align="start">
            <Button onClick={handleResetAll} tone="critical">
              {t.settings?.resetAllFields || "Alle Felder zurücksetzen"}
            </Button>
          </InlineStack>
        </div>
      )}
    </BlockStack>
    </Card>

    {/* Glossary sits in the "translations" sub-section, below the AI instructions
        card. It has its own save (via useFetcher inside the component) — separate
        from the AI instructions save button above. */}
    {subSection === "translations" && (
      <SettingsGlossaryTab
        entries={glossaryEntries}
        shopLocales={shopLocales}
        primaryShopLocale={primaryShopLocale}
        t={t}
        onHasChangesChange={onGlossaryHasChangesChange}
      />
    )}
    </BlockStack>
  );
}
