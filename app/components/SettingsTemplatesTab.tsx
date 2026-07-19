import { useEffect, useMemo, useState } from "react";
import { useFetcher } from "@remix-run/react";
import {
  Card,
  Text,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Checkbox,
  Button,
  Badge,
  Banner,
  EmptyState,
  Divider,
} from "@shopify/polaris";
import { useI18n } from "../contexts/I18nContext";
import {
  PRODUCTS_CONFIG,
  COLLECTIONS_CONFIG,
  BLOGS_CONFIG,
  PAGES_CONFIG,
  POLICIES_CONFIG,
} from "../config/content-fields.config";
import type { ContentEditorConfig, FieldDefinition } from "../types/content-editor.types";

export interface ContentTemplateEntry {
  id: string;
  name: string;
  contentType: string;
  fieldType: string;
  template: string;
  isDefault: boolean;
}

interface Props {
  templates: ContentTemplateEntry[];
  canUse: boolean;
  upgradeNotice?: string;
}

// Content types that support prompt templates. Same 5 as CONTENT_CONFIGS in
// api-ai-handlers/shared.ts. Kept as a single map so the field-options list
// below derives from the SAME field definitions the editor + AI handler use.
const CONFIGS_BY_TYPE: Record<string, ContentEditorConfig> = {
  products: PRODUCTS_CONFIG,
  collections: COLLECTIONS_CONFIG,
  blogs: BLOGS_CONFIG,
  pages: PAGES_CONFIG,
  policies: POLICIES_CONFIG,
};

// Fields that can be targeted by a prompt template = the AI-generatable
// text-style fields. Skips image-galleries, dates, non-AI structural fields.
const TEMPLATEABLE_FIELD_TYPES = new Set<FieldDefinition["type"]>([
  "text",
  "textarea",
  "html",
  "slug",
]);

function getTemplateableFieldOptions(contentType: string): { label: string; value: string }[] {
  const cfg = CONFIGS_BY_TYPE[contentType];
  if (!cfg) return [];
  return cfg.fieldDefinitions
    .filter(
      (f) =>
        f.supportsAI &&
        TEMPLATEABLE_FIELD_TYPES.has(f.type) &&
        // aiInstructionsKey is the same anchor the handler uses to pick up
        // writingStyle/formatExample/fieldInstructions — a field without it
        // has no AI-prompt path, so a template can't attach.
        Boolean(f.aiInstructionsKey),
    )
    .map((f) => ({ label: f.label, value: f.key }));
}

const AVAILABLE_VARIABLES = [
  "{{title}}",
  "{{name}}",
  "{{product_name}}",
  "{{description}}",
  "{{current_value}}",
  "{{language}}",
  "{{field_label}}",
];

const EMPTY_DRAFT = {
  id: "",
  name: "",
  contentType: "products",
  fieldType: "title",
  template: "",
  isDefault: false,
};

export function SettingsTemplatesTab({ templates, canUse, upgradeNotice }: Props) {
  const { t } = useI18n();
  const s = t.settings;
  const fetcher = useFetcher<{ success?: boolean; error?: string; errorCode?: string }>();
  const [draft, setDraft] = useState({ ...EMPTY_DRAFT });
  const [editing, setEditing] = useState(false);
  const submitting = fetcher.state !== "idle";

  // Close the editor once a save round-trip succeeds.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && editing) {
      setEditing(false);
      setDraft({ ...EMPTY_DRAFT });
    }
  }, [fetcher.state, fetcher.data, editing]);

  const contentTypeOptions = useMemo(
    () => [
      { label: s.contentTemplatesContentTypeProducts, value: "products" },
      { label: s.contentTemplatesContentTypeCollections, value: "collections" },
      { label: s.contentTemplatesContentTypeBlogs, value: "blogs" },
      { label: s.contentTemplatesContentTypePages, value: "pages" },
      { label: s.contentTemplatesContentTypePolicies, value: "policies" },
    ],
    [s],
  );

  const fieldOptions = useMemo(
    () => getTemplateableFieldOptions(draft.contentType),
    [draft.contentType],
  );

  const grouped = useMemo(() => {
    return [...templates].sort(
      (a, b) =>
        a.contentType.localeCompare(b.contentType) ||
        a.fieldType.localeCompare(b.fieldType) ||
        a.name.localeCompare(b.name),
    );
  }, [templates]);

  function submit(extra: Record<string, string>) {
    const fd = new FormData();
    Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
    fetcher.submit(fd, { method: "POST" });
  }

  function startCreate() {
    const firstField = getTemplateableFieldOptions("products")[0]?.value ?? "title";
    setDraft({ ...EMPTY_DRAFT, fieldType: firstField });
    setEditing(true);
  }

  function startEdit(tpl: ContentTemplateEntry) {
    setDraft({ ...tpl });
    setEditing(true);
  }

  function saveDraft() {
    submit({
      actionType: "saveTemplate",
      id: draft.id,
      name: draft.name,
      contentType: draft.contentType,
      fieldType: draft.fieldType,
      template: draft.template,
      isDefault: String(draft.isDefault),
    });
  }

  function contentTypeLabel(key: string): string {
    return contentTypeOptions.find((o) => o.value === key)?.label ?? key;
  }

  function fieldLabel(contentType: string, fieldKey: string): string {
    const opt = getTemplateableFieldOptions(contentType).find((o) => o.value === fieldKey);
    return opt?.label ?? fieldKey;
  }

  const availableVarsHelp = s.contentTemplatesAvailableVars.replace(
    "{vars}",
    AVAILABLE_VARIABLES.join(", "),
  );

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            {s.contentTemplates}
          </Text>
          <Text as="p" variant="bodyMd" tone="subdued">
            {s.contentTemplatesDescription}
          </Text>
          <Text as="p" variant="bodySm" tone="subdued">
            {s.contentTemplatesApplyNote}
          </Text>
        </BlockStack>

        {!canUse && (
          <Banner tone="info">
            <Text as="p" fontWeight="semibold">
              {s.contentTemplatesUpgradeNotice}
            </Text>
            {upgradeNotice && upgradeNotice !== s.contentTemplatesUpgradeNotice && (
              <Text as="p" variant="bodySm" tone="subdued">
                {upgradeNotice}
              </Text>
            )}
          </Banner>
        )}

        {(fetcher.data?.error || fetcher.data?.errorCode) && (
          <Banner tone="critical">
            <Text as="p">
              {fetcher.data?.errorCode === "defaultRace"
                ? s.contentTemplatesDefaultRaceError
                : fetcher.data?.error}
            </Text>
          </Banner>
        )}

        {canUse && !editing && (
          <InlineStack>
            <Button variant="primary" onClick={startCreate}>
              {s.contentTemplatesNewTemplate}
            </Button>
          </InlineStack>
        )}

        {canUse && editing && (
          <Card background="bg-surface-secondary">
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                {draft.id ? s.contentTemplatesEditTemplate : s.contentTemplatesNewTemplate}
              </Text>
              <TextField
                label={s.contentTemplatesName}
                autoComplete="off"
                value={draft.name}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                maxLength={100}
              />
              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Select
                    label={s.contentTemplatesContentType}
                    options={contentTypeOptions}
                    value={draft.contentType}
                    onChange={(v) => {
                      const opts = getTemplateableFieldOptions(v);
                      setDraft((d) => ({
                        ...d,
                        contentType: v,
                        fieldType: opts[0]?.value ?? "title",
                      }));
                    }}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Select
                    label={s.contentTemplatesField}
                    options={fieldOptions}
                    value={draft.fieldType}
                    onChange={(v) => setDraft((d) => ({ ...d, fieldType: v }))}
                  />
                </div>
              </InlineStack>
              <TextField
                label={s.contentTemplatesPrompt}
                autoComplete="off"
                multiline={6}
                value={draft.template}
                onChange={(v) => setDraft((d) => ({ ...d, template: v }))}
                maxLength={8000}
                helpText={availableVarsHelp}
              />
              <Checkbox
                label={s.contentTemplatesIsDefault}
                checked={draft.isDefault}
                onChange={(v) => setDraft((d) => ({ ...d, isDefault: v }))}
              />
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  loading={submitting}
                  onClick={saveDraft}
                >
                  {s.contentTemplatesSave}
                </Button>
                <Button
                  disabled={submitting}
                  onClick={() => {
                    setEditing(false);
                    setDraft({ ...EMPTY_DRAFT });
                  }}
                >
                  {s.contentTemplatesCancel}
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Divider />

        {grouped.length === 0 ? (
          <EmptyState
            heading={s.contentTemplatesEmptyHeading}
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>{s.contentTemplatesEmptyBody}</p>
          </EmptyState>
        ) : (
          <BlockStack gap="300">
            {grouped.map((tpl) => (
              <Card key={tpl.id}>
                <BlockStack gap="200">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200" blockAlign="center">
                      <Text as="span" fontWeight="semibold">
                        {tpl.name}
                      </Text>
                      <Badge>{contentTypeLabel(tpl.contentType)}</Badge>
                      <Badge>{fieldLabel(tpl.contentType, tpl.fieldType)}</Badge>
                      {tpl.isDefault && (
                        <Badge tone="success">{s.contentTemplatesDefaultBadge}</Badge>
                      )}
                    </InlineStack>
                    {canUse && (
                      <InlineStack gap="200">
                        {!tpl.isDefault && (
                          <Button
                            size="slim"
                            disabled={submitting}
                            onClick={() =>
                              submit({
                                actionType: "setDefaultTemplate",
                                id: tpl.id,
                              })
                            }
                          >
                            {s.contentTemplatesMakeDefault}
                          </Button>
                        )}
                        <Button
                          size="slim"
                          disabled={submitting}
                          onClick={() => startEdit(tpl)}
                        >
                          {s.contentTemplatesEditRow}
                        </Button>
                        <Button
                          size="slim"
                          tone="critical"
                          disabled={submitting}
                          onClick={() =>
                            submit({
                              actionType: "deleteTemplate",
                              id: tpl.id,
                            })
                          }
                        >
                          {s.contentTemplatesDeleteRow}
                        </Button>
                      </InlineStack>
                    )}
                  </InlineStack>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {tpl.template.length > 160
                      ? `${tpl.template.slice(0, 160)}…`
                      : tpl.template}
                  </Text>
                </BlockStack>
              </Card>
            ))}
          </BlockStack>
        )}
      </BlockStack>
    </Card>
  );
}
