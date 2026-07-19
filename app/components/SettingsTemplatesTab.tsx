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

const CONTENT_TYPE_OPTIONS = [
  { label: "Products", value: "products" },
  { label: "Collections", value: "collections" },
  { label: "Blog articles", value: "blogs" },
  { label: "Pages", value: "pages" },
  { label: "Policies", value: "policies" },
];

// Field keys mirror the editor's field.key values used by the AI handler.
const FIELD_OPTIONS_BY_TYPE: Record<string, { label: string; value: string }[]> = {
  products: [
    { label: "Title", value: "title" },
    { label: "Description", value: "description" },
    { label: "SEO title", value: "seoTitle" },
    { label: "Meta description", value: "metaDescription" },
    { label: "URL handle", value: "handle" },
  ],
  collections: [
    { label: "Title", value: "title" },
    { label: "Description", value: "description" },
    { label: "SEO title", value: "seoTitle" },
    { label: "Meta description", value: "metaDescription" },
    { label: "URL handle", value: "handle" },
  ],
  blogs: [
    { label: "Title", value: "title" },
    { label: "Description", value: "description" },
    { label: "SEO title", value: "seoTitle" },
    { label: "Meta description", value: "metaDescription" },
    { label: "URL handle", value: "handle" },
  ],
  pages: [
    { label: "Title", value: "title" },
    { label: "Description", value: "description" },
    { label: "URL handle", value: "handle" },
  ],
  policies: [{ label: "Description", value: "description" }],
};

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
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
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

  const fieldOptions = useMemo(
    () => FIELD_OPTIONS_BY_TYPE[draft.contentType] ?? FIELD_OPTIONS_BY_TYPE.products,
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
    setDraft({ ...EMPTY_DRAFT });
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

  return (
    <Card>
      <BlockStack gap="400">
        <BlockStack gap="100">
          <Text as="h2" variant="headingMd">
            Content templates
          </Text>
          <Text as="p" tone="subdued" variant="bodySm">
            Reusable AI prompt presets. Use {"{{variables}}"} that are replaced
            with the current content before the AI call. Set one template as the
            default per content type and field — it is then applied
            automatically when generating that field.
          </Text>
        </BlockStack>

        {!canUse && (
          <Banner tone="info">
            <Text as="p" fontWeight="semibold">
              Content templates are available on the Pro and Max plans.
            </Text>
            {upgradeNotice && (
              <Text as="p" variant="bodySm" tone="subdued">
                {upgradeNotice}
              </Text>
            )}
          </Banner>
        )}

        {fetcher.data?.error && (
          <Banner tone="critical">
            <Text as="p">{fetcher.data.error}</Text>
          </Banner>
        )}

        {canUse && !editing && (
          <InlineStack>
            <Button variant="primary" onClick={startCreate}>
              New template
            </Button>
          </InlineStack>
        )}

        {canUse && editing && (
          <Card background="bg-surface-secondary">
            <BlockStack gap="300">
              <Text as="h3" variant="headingSm">
                {draft.id ? "Edit template" : "New template"}
              </Text>
              <TextField
                label="Name"
                autoComplete="off"
                value={draft.name}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                maxLength={100}
              />
              <InlineStack gap="300" wrap={false}>
                <div style={{ flex: 1 }}>
                  <Select
                    label="Content type"
                    options={CONTENT_TYPE_OPTIONS}
                    value={draft.contentType}
                    onChange={(v) => {
                      const opts = FIELD_OPTIONS_BY_TYPE[v] ?? [];
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
                    label="Field"
                    options={fieldOptions}
                    value={draft.fieldType}
                    onChange={(v) => setDraft((d) => ({ ...d, fieldType: v }))}
                  />
                </div>
              </InlineStack>
              <TextField
                label="Template"
                autoComplete="off"
                multiline={6}
                value={draft.template}
                onChange={(v) => setDraft((d) => ({ ...d, template: v }))}
                maxLength={8000}
                helpText={`Available variables: ${AVAILABLE_VARIABLES.join(", ")}`}
              />
              <Checkbox
                label="Apply automatically (default for this content type + field)"
                checked={draft.isDefault}
                onChange={(v) => setDraft((d) => ({ ...d, isDefault: v }))}
              />
              <InlineStack gap="300">
                <Button
                  variant="primary"
                  loading={submitting}
                  onClick={saveDraft}
                >
                  Save
                </Button>
                <Button
                  disabled={submitting}
                  onClick={() => {
                    setEditing(false);
                    setDraft({ ...EMPTY_DRAFT });
                  }}
                >
                  Cancel
                </Button>
              </InlineStack>
            </BlockStack>
          </Card>
        )}

        <Divider />

        {grouped.length === 0 ? (
          <EmptyState
            heading="No templates yet"
            image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
          >
            <p>
              Create reusable prompt presets to keep AI output consistent across
              your catalog.
            </p>
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
                      <Badge>{tpl.contentType}</Badge>
                      <Badge>{tpl.fieldType}</Badge>
                      {tpl.isDefault && (
                        <Badge tone="success">Default</Badge>
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
                            Make default
                          </Button>
                        )}
                        <Button
                          size="slim"
                          disabled={submitting}
                          onClick={() => startEdit(tpl)}
                        >
                          Edit
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
                          Delete
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
