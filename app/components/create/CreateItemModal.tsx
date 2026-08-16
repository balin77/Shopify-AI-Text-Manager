/**
 * PLAN_CONTENT_CREATION §1.4 — the create dialog behind the "+" button.
 *
 * Renders generically from `create-fields.config.ts`, so a new field is one
 * entry in that file rather than a change here AND there. The same file's
 * `validateCreatePayload` runs on both sides: here for immediate feedback,
 * again on the server because that is where the rule actually lives (§1.5).
 *
 * *Why a modal and not the `NEW_ID` pattern Direct Translations uses (§0.2):*
 * there, exactly one field is mandatory (the source string). Here each type has
 * several, some type-dependent — an editor form with unsatisfiable required
 * fields and a live save bar would be the worse experience. The deviation is
 * deliberate, and it is paid for by respecting the save-bar convention:
 * closing with unsaved input goes through `confirmNavigation()`.
 *
 * **No browser storage for drafts.** localStorage/sessionStorage were removed
 * for App Store compliance; an unfinished form lives in memory and is protected
 * by the close confirmation, not by a persisted draft.
 */

import { useCallback, useMemo, useState } from "react";
import {
  Modal,
  BlockStack,
  InlineStack,
  TextField,
  Select,
  Button,
  Text,
  Banner,
  Thumbnail,
  Collapsible,
  Box,
} from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import {
  createSpecFor,
  suggestHandle,
  validateCreatePayload,
  type CreatableResource,
  type CreateFieldDef,
  type CreateValidationError,
} from "~/config/create-fields.config";

export interface CreateItemModalTexts {
  title?: string;
  create?: string;
  cancel?: string;
  moreFields?: string;
  fewerFields?: string;
  required?: string;
  handleHint?: string;
  discardConfirm?: string;
  /** Field labels, keyed exactly like `CreateFieldDef.labelKey`. */
  fields?: Record<string, string>;
  /** Option labels, keyed like `"status.DRAFT"`. */
  options?: Record<string, string>;
}

export interface CreateItemModalProps {
  open: boolean;
  onClose: () => void;
  resource: CreatableResource;
  /** Extra fields only known at runtime — a metaobject definition's own fields. */
  extraFields?: CreateFieldDef[];
  /** Extra fields that depend on a CHOICE inside the form: a metaobject's own
   *  fields only exist once its definition is picked. Keyed by that value. */
  extraFieldsByOption?: Record<string, CreateFieldDef[]>;
  /** Which field's value selects from `extraFieldsByOption`. */
  extraFieldsKey?: string;
  /** §1.7 — shown instead of the form when an article has no blog to live in. */
  blocked?: { message: string; actionLabel?: string; onAction?: () => void } | null;
  /** Options for `blogPicker` / `metaobjectType`, loaded by the caller. */
  dynamicOptions?: Record<string, Array<{ value: string; label: string; disabled?: boolean; helpText?: string }>>;
  /** Hands the payload to the caller. Fire-and-forget: the outcome arrives
   *  through `submitting` / `error` / `fieldErrors`, because the underlying
   *  fetcher is not promise-shaped. */
  onSubmit: (payload: CreateSubmitPayload) => void | Promise<void>;
  submitting?: boolean;
  /** Server-side failure, shown verbatim — never swallowed. */
  error?: string | null;
  /** Field-level errors the SERVER rejected, so the two validators agree visibly. */
  fieldErrors?: CreateValidationError[];
  t?: CreateItemModalTexts;
}

export interface CreateSubmitPayload {
  resource: CreatableResource;
  values: Record<string, string>;
  imageUrl: string;
  imageAlt: string;
  /** Minted per attempt — the server de-duplicates on it (§1.7). */
  requestId: string;
}

/** Crypto-free unique enough for a per-click dedup key. */
function mintRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CreateItemModal({
  open,
  onClose,
  resource,
  extraFields = [],
  extraFieldsByOption = {},
  extraFieldsKey,
  blocked = null,
  dynamicOptions = {},
  onSubmit,
  submitting = false,
  error,
  fieldErrors = [],
  t = {},
}: CreateItemModalProps) {
  const spec = createSpecFor(resource);
  const [values, setValues] = useState<Record<string, string>>({});
  const [image, setImage] = useState<{ url: string; preview: string; alt: string } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [touched, setTouched] = useState(false);

  // A metaobject's own fields appear only once its definition is chosen —
  // rendering them before that would ask for values against no schema.
  const chosenExtras = useMemo(() => {
    if (!extraFieldsKey) return [] as CreateFieldDef[];
    const chosen = values[extraFieldsKey];
    return chosen ? extraFieldsByOption[chosen] ?? [] : [];
  }, [extraFieldsKey, extraFieldsByOption, values]);

  const runtimeFields = useMemo(() => [...extraFields, ...chosenExtras], [extraFields, chosenExtras]);
  const allFields = useMemo(() => [...(spec?.fields ?? []), ...runtimeFields], [spec, runtimeFields]);
  const basicFields = allFields.filter((f) => !f.advanced);
  const advancedFields = allFields.filter((f) => f.advanced);

  const localErrors = useMemo(
    () => (spec ? validateCreatePayload(resource, values, runtimeFields) : []),
    [spec, resource, values, runtimeFields],
  );
  // Server errors win: they are the authority, and showing only the local ones
  // would hide a rejection the merchant has to act on.
  const shownErrors = fieldErrors.length > 0 ? fieldErrors : touched ? localErrors : [];
  const errorFor = (key: string) => shownErrors.find((e) => e.field === key);

  const isDirty = Object.values(values).some((v) => v.trim().length > 0) || !!image;
  const canSubmit = !submitting && !blocked && localErrors.length === 0;

  const setValue = useCallback((key: string, value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleClose = useCallback(() => {
    // AppSaveBar convention (§1.4): unsaved input is never dropped silently.
    if (isDirty && !window.confirm(t.discardConfirm || "Discard this draft?")) return;
    setValues({});
    setImage(null);
    setTouched(false);
    setShowAdvanced(false);
    onClose();
  }, [isDirty, onClose, t.discardConfirm]);

  const handleSubmit = useCallback(() => {
    setTouched(true);
    if (localErrors.length > 0) return;
    onSubmit({
      resource,
      values,
      imageUrl: image?.url ?? "",
      imageAlt: image?.alt ?? "",
      requestId: mintRequestId(),
    });
  }, [localErrors, onSubmit, resource, values, image]);

  /**
   * The picker can return video and 3D as well. Swallowing those silently is
   * not an option (§1.4), and this dialog only knows how to attach ONE image —
   * so a non-image pick is refused with a reason rather than ignored.
   */
  const handlePicked = useCallback((items: AddedItem[]) => {
    const first = items[0];
    setPickerOpen(false);
    if (!first) return;
    if (first.source === "upload") {
      if (first.kind !== "image") {
        window.alert("Only images can be attached here. Add video or 3D from the item's media manager after creating it.");
        return;
      }
      setImage({ url: first.resourceUrl, preview: first.previewUrl, alt: "" });
      return;
    }
    if (first.source === "library") {
      if (first.kind !== "image") {
        window.alert("Only images can be attached here. Add video or 3D from the item's media manager after creating it.");
        return;
      }
      setImage({ url: first.assetUrl, preview: first.previewUrl, alt: first.alt ?? "" });
      return;
    }
    // external_url is a video embed — not an image, and not attachable here.
    window.alert("An external video link cannot be used as an item image.");
  }, []);

  if (!spec) return null;

  const label = (field: CreateFieldDef) => t.fields?.[field.labelKey] ?? field.labelKey;

  const renderField = (field: CreateFieldDef) => {
    const value = values[field.key] ?? "";
    const fieldError = errorFor(field.key);
    const errorText = fieldError
      ? fieldError.code === "required"
        ? t.required || "Required"
        : `${fieldError.code}${fieldError.detail ? ` (${fieldError.detail})` : ""}`
      : undefined;

    switch (field.kind) {
      case "image":
        return (
          <BlockStack gap="200" key={field.key}>
            <Text as="p" variant="bodyMd">{label(field)}</Text>
            <InlineStack gap="300" blockAlign="center">
              {image && <Thumbnail source={image.preview} alt="" size="small" />}
              <Button onClick={() => setPickerOpen(true)}>
                {image ? "Change image" : "Choose image"}
              </Button>
              {image && <Button variant="plain" tone="critical" onClick={() => setImage(null)}>Remove</Button>}
            </InlineStack>
            {image && (
              <TextField
                label="Alt text"
                value={image.alt}
                onChange={(v) => setImage((prev) => (prev ? { ...prev, alt: v } : prev))}
                autoComplete="off"
              />
            )}
          </BlockStack>
        );

      case "select":
        return (
          <Select
            key={field.key}
            label={label(field)}
            options={(field.options ?? []).map((o) => ({
              value: o.value,
              label: t.options?.[o.labelKey] ?? o.value,
            }))}
            value={value || field.options?.[0]?.value || ""}
            onChange={(v) => setValue(field.key, v)}
            error={errorText}
          />
        );

      case "blogPicker":
      case "metaobjectType": {
        const options = dynamicOptions[field.key] ?? [];
        return (
          <Select
            key={field.key}
            label={label(field)}
            options={[{ value: "", label: "—" }, ...options]}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            error={errorText}
            helpText={options.find((o) => o.value === value)?.helpText}
          />
        );
      }

      case "textarea":
      case "richtext":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            multiline={field.kind === "richtext" ? 6 : 3}
            autoComplete="off"
            maxLength={field.maxLength}
            showCharacterCount={!!field.maxLength}
            error={errorText}
          />
        );

      case "handle":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
            // The suggestion is a hint, never a promise: Shopify decides, and
            // on a collision it appends "-1" (§1.7). The post-create box
            // reports the handle that actually came BACK.
            placeholder={suggestHandle(values.title ?? "")}
            helpText={t.handleHint}
          />
        );

      case "tags":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            error={errorText}
            helpText="Comma-separated"
          />
        );

      case "money":
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            inputMode="decimal"
            error={errorText}
          />
        );

      default:
        return (
          <TextField
            key={field.key}
            label={label(field)}
            value={value}
            onChange={(v) => setValue(field.key, v)}
            autoComplete="off"
            maxLength={field.maxLength}
            error={errorText}
          />
        );
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={handleClose}
        title={t.title || `New ${spec.titleKey}`}
        primaryAction={{
          content: t.create || "Create",
          onAction: handleSubmit,
          loading: submitting,
          disabled: !canSubmit,
        }}
        secondaryActions={[{ content: t.cancel || "Cancel", onAction: handleClose, disabled: submitting }]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {blocked && (
              <Banner tone="warning" title={blocked.message}>
                {blocked.onAction && blocked.actionLabel && (
                  <Box paddingBlockStart="200">
                    <Button onClick={blocked.onAction}>{blocked.actionLabel}</Button>
                  </Box>
                )}
              </Banner>
            )}

            {error && (
              <Banner tone="critical" title="Could not create">
                <p>{error}</p>
              </Banner>
            )}

            {spec.createsUnpublished && (
              <Banner tone="info">
                <p>
                  This is created as a draft — nothing goes live until you publish it.
                </p>
              </Banner>
            )}

            {!blocked && basicFields.map(renderField)}

            {!blocked && advancedFields.length > 0 && (
              <BlockStack gap="200">
                <Button
                  variant="plain"
                  disclosure={showAdvanced ? "up" : "down"}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? t.fewerFields || "Fewer fields" : t.moreFields || "More fields"}
                </Button>
                <Collapsible open={showAdvanced} id="create-advanced-fields">
                  <Box paddingBlockStart="200">
                    <BlockStack gap="400">{advancedFields.map(renderField)}</BlockStack>
                  </Box>
                </Collapsible>
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>

      {pickerOpen && (
        <FilePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onAdd={handlePicked}
          uploadCommitMode="immediate"
          initialKind="image"
          disallowModel
          title="Choose an image"
        />
      )}
    </>
  );
}
