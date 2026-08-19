/**
 * The editor for a metaobject field of Shopify type `file_reference`.
 *
 * The stored value is a File GID, so picking is the whole interaction: there is
 * nothing to type. It reuses the shipped `FilePickerModal` -- library browsing
 * AND the staged-upload chain -- rather than growing a second picker.
 *
 * An UPLOAD has to be materialised before it can be referenced: the picker
 * hands back a staged `resourceUrl`, which is not a File yet, and writing that
 * into the field would store a URL where Shopify expects a GID. `/api/create-
 * shopify-file` performs the `fileCreate` and returns the permanent id, which
 * is what lands in the field.
 *
 * The current value's THUMBNAIL comes from the shop's media cache (shipped by
 * the metaobjects loader). A GID that is not cached renders as the id with a
 * note, never as a broken image -- "we do not have a preview" and "the file is
 * gone" are different states and only Shopify can tell them apart.
 *
 * Read-only outside the primary locale, for the same reason as the colour
 * field: a file reference has one value per shop.
 */

import { useCallback, useState } from "react";
import { Banner, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { FieldClearOverlay, FieldLabel } from "../unified/FieldChrome";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import type { FieldRenderProps } from "~/types/content-editor.types";

interface Props extends FieldRenderProps {
  /** Thumbnail for the CURRENT value, when the shop's media cache knows it. */
  previewUrl?: string;
}

export function MetaobjectFileField({
  field,
  value,
  onChange,
  isPrimaryLocale = true,
  readOnly: editorReadOnly = false,
  previewUrl,
  t,
}: Props) {
  // Same two reasons as the colour field: a file reference has ONE value per
  // shop, and the definition may refuse our writes entirely (§7.2).
  const readOnly = !isPrimaryLocale || editorReadOnly;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Preview of a value picked in THIS session, where the cache has none yet. */
  const [localPreview, setLocalPreview] = useState<string | null>(null);

  const content = (t as { content?: Record<string, string> } | undefined)?.content ?? {};

  const handleAdd = useCallback(
    async (items: AddedItem[]) => {
      const item = items[0];
      if (!item) return;
      setError(null);
      // `/api/create-shopify-file` creates an IMAGE, and this field's picker
      // only filters by default rather than restricting — a merchant can
      // switch to videos. Refusing here with the reason beats an opaque "could
      // not be stored as a file" after the fact. A staged upload that is never
      // materialised is a temporary object, so nothing is left in the library.
      if ((item.source === "library" || item.source === "upload") && item.kind !== "image") {
        setError(content.metaobjectEntryImagesOnly || "Only images can be used in this field.");
        return;
      }
      if (item.source === "library") {
        onChange(item.gid);
        setLocalPreview(item.previewUrl || null);
        setOpen(false);
        return;
      }
      if (item.source === "upload") {
        // A staged upload is not a File yet — materialise it, because the field
        // stores a GID and a staged URL would be stored as a plain string that
        // resolves to nothing.
        setBusy(true);
        try {
          // JSON, not FormData: the route parses with `request.json()` and
          // reads exactly `resourceUrl` and `alt`. A multipart body reaches it
          // as an unparseable string and every upload fails.
          const res = await fetch("/api/create-shopify-file", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ resourceUrl: item.resourceUrl, alt: item.fileName }),
          });
          const data = await res.json();
          // The file id is what the FIELD stores. Shopify produces the CDN url
          // asynchronously, so a response that carries an id but no url (504)
          // is still a usable reference — refusing it would leave an orphaned
          // file in the merchant's library and no value in the field.
          if (!data.fileId) {
            setError(typeof data.error === "string" ? data.error : "The upload could not be stored as a file.");
            return;
          }
          onChange(data.fileId);
          setLocalPreview(data.url || item.previewUrl || null);
          setOpen(false);
        } catch (e) {
          setError(e instanceof Error ? e.message : String(e));
        } finally {
          setBusy(false);
        }
        return;
      }
      // An external video URL is not a file reference at all.
      setError("Only files from your library or an upload can be used here.");
    },
    [onChange],
  );

  const shownPreview = localPreview ?? previewUrl ?? null;

  const clear = () => {
    onChange("");
    setLocalPreview(null);
  };

  return (
    // The label and the way to empty the field are the SHARED field chrome, so
    // this control wears the same bold label and the same top-right "Clear" as
    // the text field beside it in the card. It used to print a regular-weight
    // label of its own and a second, differently-worded remove button inline —
    // two of the four fields on a colour entry looked like two different apps.
    <FieldClearOverlay
      onClear={readOnly ? undefined : clear}
      hasValue={!!value}
      fieldLabel={field.label}
    >
      <BlockStack gap="150">
        <FieldLabel label={field.label} />
        {error && (
          <Banner tone="critical" onDismiss={() => setError(null)}>
            <p>{error}</p>
          </Banner>
        )}
        <InlineStack gap="200" blockAlign="center" wrap={false}>
          {/* The tile is drawn whether or not there is a picture in it: an empty
              frame says "an image belongs here", while the bare em-dash it
              replaced floated in the row and left the field a different height
              from every other one in the grid. */}
          {shownPreview ? (
            <img
              src={shownPreview}
              alt=""
              style={{
                width: "48px",
                height: "48px",
                objectFit: "cover",
                borderRadius: "6px",
                border: "1px solid var(--p-color-border)",
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: "48px",
                height: "48px",
                borderRadius: "6px",
                border: "1px dashed var(--p-color-border)",
                background: "var(--p-color-bg-surface-secondary)",
                flexShrink: 0,
              }}
            />
          )}
          {/* A value the media cache has no preview for is NAMED rather than
              shown as an empty tile with nothing beside it — "we have no
              thumbnail" and "no image is set" are different states. */}
          {value && !shownPreview && (
            <div style={{ minWidth: 0, overflow: "hidden" }}>
              <Text as="span" variant="bodySm" tone="subdued" truncate>
                {value.split("/").pop()}
              </Text>
            </div>
          )}
          {!readOnly && (
            <Button size="slim" loading={busy} onClick={() => setOpen(true)}>
              {value
                ? content.metaobjectEntryChangeImage || "Change image"
                : content.metaobjectEntryPickImage || "Choose image"}
            </Button>
          )}
        </InlineStack>
        {readOnly && (
          <Text as="span" variant="bodySm" tone="subdued">
            {/* Same two causes as the colour field — see the note there. */}
            {!isPrimaryLocale
              ? content.attributesForeignLocale || "This value exists once per shop, not per language."
              : content.metaobjectEntryReadOnlyDefinition ||
                "This app cannot change entries of this definition."}
          </Text>
        )}
        {open && (
          <FilePickerModal
            open={open}
            onClose={() => setOpen(false)}
            onAdd={(items) => void handleAdd(items)}
            uploadCommitMode="immediate"
            initialKind="image"
            disallowModel
            title={field.label}
          />
        )}
      </BlockStack>
    </FieldClearOverlay>
  );
}
