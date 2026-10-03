/**
 * A theme setting whose value is an IMAGE (`shopify://shop_images/<file>`),
 * rendered as a picture with "choose an image for this language" instead of a
 * text box (PLAN_LOCALIZED_IMAGES Phase 1a).
 *
 * The value this field holds is still just a string, and it saves through the
 * ordinary theme save path — translationsRegister with its echo check, the
 * market layer through the page's market selector, the `ThemeTranslation`
 * mirror. Choosing an image writes `shopify://shop_images/<file>`; "reset"
 * writes `""`, which that path already turns into a removal, so the original
 * shows again.
 *
 * It never offers the AI anything: an image reference is a file choice, and
 * every AI path refuses it server-side as well (theme-image-reference.shared).
 * In the PRIMARY locale it is a preview: the original is chosen in Shopify's
 * theme editor, which is where every theme setting's primary value lives.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Badge, Banner, BlockStack, Button, InlineStack, Text } from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import { FieldLabel } from "../unified/FieldChrome";
import { useI18n } from "../../contexts/I18nContext";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { resolvePickedImage } from "./resolve-picked-image";
import {
  filenameFromCdnUrl,
  themeImageFilename,
  themeImageReferenceFor,
} from "../../utils/theme-image-reference.shared";

// One lookup per filename per page session: a theme group can carry dozens of
// image settings, and each re-render must not refetch.
const urlCache = new Map<string, Promise<string | null>>();

function lookupImageUrl(filename: string): Promise<string | null> {
  let hit = urlCache.get(filename);
  if (!hit) {
    hit = fetch(`/api/files?filename=${encodeURIComponent(filename)}`)
      .then((r) => (r.ok ? r.json() : { files: [] }))
      .then((j: { files?: Array<{ assetUrl?: string }> }) => j.files?.[0]?.assetUrl || null)
      .catch(() => null);
    // A failed lookup is not remembered: the next render may ask again.
    hit.then((u) => { if (u === null) urlCache.delete(filename); });
    urlCache.set(filename, hit);
  }
  return hit;
}

function useImageUrl(filename: string | null): string | null | undefined {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    if (!filename) { setUrl(null); return; }
    lookupImageUrl(filename).then((u) => { if (alive) setUrl(u); });
    return () => { alive = false; };
  }, [filename]);
  return url;
}

export interface ThemeImageFieldProps {
  label: string;
  /** What the editor holds for this locale (a foreign locale's "" = no translation). */
  value: string;
  /** The primary locale's reference. */
  primaryValue: string;
  onChange: (value: string) => void;
  isPrimaryLocale: boolean;
  readOnly?: boolean;
  currentLanguage?: string;
}

export function ThemeImageField({
  label,
  value,
  primaryValue,
  onChange,
  isPrimaryLocale,
  readOnly,
  currentLanguage,
}: ThemeImageFieldProps) {
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The language showing NOW: a pick that resolves after a switch belongs to
  // the language it was made in, so it is dropped rather than written into the
  // one on screen. The error banner is per language as well.
  const languageRef = useRef(currentLanguage);
  languageRef.current = currentLanguage;
  useEffect(() => { setError(null); }, [currentLanguage]);

  // A value equal to the primary reference is the original shining through
  // (whether the editor resolved a fallback or a translation repeats it).
  const own = !isPrimaryLocale && themeImageFilename(value) !== null && value.trim() !== primaryValue.trim();
  const shownFilename = themeImageFilename(own ? value : primaryValue);
  const url = useImageUrl(shownFilename);

  const handleAdd = useCallback(async (items: AddedItem[]) => {
    const startedIn = languageRef.current;
    setPickerOpen(false);
    setError(null);
    setBusy(true);
    const picked = await resolvePickedImage(items.find((i) => i.source !== "external_url") ?? items[0]);
    setBusy(false);
    if (languageRef.current !== startedIn) return;
    if ("error" in picked) {
      const known = picked.code ? (tx.errors as Record<string, string>)[picked.code] : undefined;
      setError(known ?? tx.fileFailed.replace("{error}", picked.error));
      return;
    }
    const raw = filenameFromCdnUrl(picked.url);
    if (!raw) {
      setError(tx.fileFailed.replace("{error}", "no filename"));
      return;
    }
    // A theme reference names the file as Files knows it, i.e. decoded.
    let name = raw;
    try { name = decodeURIComponent(raw); } catch { /* keep raw */ }
    urlCache.set(name, Promise.resolve(picked.url));
    onChange(themeImageReferenceFor(name));
  }, [onChange, tx]);

  return (
    <BlockStack gap="200">
      <FieldLabel label={label} />
      <InlineStack gap="300" blockAlign="center" wrap={false}>
        <div
          style={{
            width: 96,
            height: 96,
            flex: "0 0 96px",
            border: "1px solid var(--app-surface-border-color)",
            borderRadius: "var(--app-field-border-radius)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: "hidden",
            background: "var(--p-color-bg-surface-secondary)",
          }}
        >
          {url ? (
            <img src={url} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          ) : (
            <Text as="span" variant="bodySm" tone="subdued">
              {url === undefined ? "…" : tx.previewUnavailable}
            </Text>
          )}
        </div>
        <BlockStack gap="150">
          {!isPrimaryLocale && (
            <InlineStack gap="200">
              <Badge tone={own ? "success" : undefined}>{own ? tx.replaced : tx.usingOriginal}</Badge>
            </InlineStack>
          )}
          <Text as="span" variant="bodySm" tone="subdued" breakWord>
            {shownFilename ?? ""}
          </Text>
          {isPrimaryLocale ? (
            <Text as="p" variant="bodySm" tone="subdued">{tx.primaryReadOnly}</Text>
          ) : (
            <InlineStack gap="200">
              <Button size="slim" onClick={() => setPickerOpen(true)} disabled={readOnly || busy} loading={busy}>
                {own ? tx.changeImage : tx.chooseImage}
              </Button>
              {own && (
                <Button size="slim" variant="plain" tone="critical" onClick={() => onChange("")} disabled={readOnly || busy}>
                  {tx.reset}
                </Button>
              )}
            </InlineStack>
          )}
          {!isPrimaryLocale && <Text as="p" variant="bodySm" tone="subdued">{tx.themeFieldHint}</Text>}
        </BlockStack>
      </InlineStack>
      {error && <Banner tone="critical" onDismiss={() => setError(null)}><Text as="p">{error}</Text></Banner>}
      {pickerOpen && (
        <FilePickerModal
          open={pickerOpen}
          onClose={() => setPickerOpen(false)}
          onAdd={handleAdd}
          uploadCommitMode="queue"
          initialKind="image"
          imagesOnly
          title={tx.pickerTitle.replace("{locale}", currentLanguage ? getLocalizedLanguageName(currentLanguage, appLocale) : "")}
        />
      )}
    </BlockStack>
  );
}
