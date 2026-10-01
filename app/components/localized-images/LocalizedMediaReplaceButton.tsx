/**
 * Per-language replacement of ONE selected product medium: just buttons.
 *
 * "Ersatzbild hochladen" opens the file picker; the pick becomes a DRAFT (the
 * tile shows it at once, the editor's save bar writes it). "Ersatzbild
 * entfernen" appears once the medium has a replacement of its own for the
 * language (and market) and is a draft too. No panel, no preview, no hints: the
 * gallery tile is where the result shows (with the corner symbol that flips to
 * the original). Rendered by BOTH galleries for their one selected medium; the
 * state lives in LocalizedMediaContext. Primary locale: nothing at all.
 */
import { useCallback, useEffect, useState } from "react";
import { Banner, BlockStack, Button, InlineStack, Modal, Text, TextField } from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useI18n } from "../../contexts/I18nContext";
import { useRegisterCommerceSave } from "../../contexts/CommerceSaveContext";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { parseExternalVideoUrl } from "../../utils/mediaKind";
import { resolvePickedMedia } from "./resolve-picked-image";
import { filenameFromUrl } from "./localized-media-view.shared";
import { marketNumericId } from "../../services/localized-media/localized-media.shared";
import { useLocalizedMediaContext } from "./LocalizedMediaContext";
import { ReplacedMediaBadge } from "./ReplacedMediaBadge";

/** Registers the media drafts with the editor's ONE save bar (see CommerceSaveContext). */
export function LocalizedMediaSaveBridge() {
  const state = useLocalizedMediaContext()?.state;
  const register = useRegisterCommerceSave("localizedMedia");
  const hasChanges = state?.hasDrafts ?? false;
  const saving = state?.saving ?? false;
  const save = state?.save;
  const discard = state?.discard;
  useEffect(() => {
    if (!save || !discard) return;
    register({ hasChanges, saving, save, discard });
    // Unregister on unmount / product change: a stale `save` bound to the
    // previous product must never write.
    return () => register(null);
  }, [register, hasChanges, saving, save, discard]);
  return null;
}

/** Thumbnail of a YouTube link for the tile preview; Vimeo publishes none without an API call. */
function externalPreview(url: string): string {
  const parsed = parseExternalVideoUrl(url);
  return parsed?.host === "youtube" ? `https://img.youtube.com/vi/${parsed.externalId}/hqdefault.jpg` : "";
}

export function LocalizedMediaReplaceButtons({ mediaId }: { mediaId: string }) {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;
  const [pickerKind, setPickerKind] = useState<"image" | "video" | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  const [linkError, setLinkError] = useState(false);
  // Between choosing a file and the draft: a fresh upload is materialised first.
  const [resolving, setResolving] = useState(false);

  const state = ctx?.state;
  const m = state?.mediaById.get(mediaId);
  const draftFile = state?.draftFile;
  const reportPickFailure = state?.reportPickFailure;
  const draftLink = state?.draftLink;
  const mediaKind = m?.kind;

  const handlePicked = useCallback(async (items: AddedItem[]) => {
    const kind = pickerKind;
    setPickerKind(null);
    if (!kind || !mediaKind || !draftFile || !reportPickFailure) return;
    // The slot the pick started in: the upload can outlast a language/market switch.
    const slot = { locale: state?.rawLocale ?? "", marketId: state?.marketId ?? "", productId: state?.productId };
    setResolving(true);
    try {
      const picked = await resolvePickedMedia(items.find((i) => i.source !== "external_url") ?? items[0], kind);
      if ("error" in picked) {
        reportPickFailure(picked.code, picked.error);
        return;
      }
      // A video file's URL is not a picture: the tile keeps the original's poster.
      draftFile(mediaId, mediaKind, picked.fileId, kind === "image" ? picked.url : "", filenameFromUrl(picked.url), slot);
    } finally {
      setResolving(false);
    }
  }, [pickerKind, mediaKind, draftFile, reportPickFailure, mediaId, state?.rawLocale, state?.marketId, state?.productId]);

  const handleLinkSave = useCallback(() => {
    const externalUrl = linkValue.trim();
    if (!externalUrl || !draftLink) return;
    // The server validates again on save; a plain mistake is said here, in the dialog.
    if (!parseExternalVideoUrl(externalUrl)) {
      setLinkError(true);
      return;
    }
    setLinkOpen(false);
    setLinkValue("");
    setLinkError(false);
    draftLink(mediaId, externalUrl, externalPreview(externalUrl));
  }, [linkValue, draftLink, mediaId]);

  // Primary locale or not a product page: nothing at all.
  if (!ctx || !state || !state.active) return null;

  if (state.foreignValue) {
    // Nothing in a metafield this app did not write may be listed or changed.
    return <Text as="span" variant="bodySm" tone="subdued">{tx.foreignValueNotice}</Text>;
  }
  if (state.loadError && !state.loaded) {
    return (
      <InlineStack gap="100" blockAlign="center">
        <Text as="span" variant="bodySm" tone="subdued">{tx.loadFailed}</Text>
        <Button size="slim" variant="plain" onClick={() => void state.load()}>{tx.retry}</Button>
      </InlineStack>
    );
  }
  if (!m) {
    // Not loaded yet, still processing on Shopify, or added after the last
    // read: shown disabled with the reason, never silently absent.
    // Before the first answer (or its error) the medium is simply not known
    // yet: that is loading, not "not available".
    const stillLoading = state.loading || (!state.loaded && !state.loadError);
    if (!state.canReplace) return null;
    return (
      <DisabledActionTooltip hint={stillLoading ? undefined : tx.notYetAvailable}>
        <Button size="slim" disabled loading={stillLoading}>{tx.replace}</Button>
      </DisabledActionTooltip>
    );
  }

  const languageName = getLocalizedLanguageName(state.rawLocale, appLocale);
  const replaceLabel = m.kind === "external" ? tx.replaceLink : m.kind === "video" ? tx.replaceVideo : tx.replace;
  const removeLabel = m.kind === "external" ? tx.removeLink : m.kind === "video" ? tx.removeVideo : tx.removeImage;
  // A medium whose storefront key could not be derived cannot be swapped on the
  // storefront, so it is not offered — said, not hidden.
  const blockedHint = m.key ? undefined : tx.cannotReplace;
  const disabled = !m.key || resolving || state.saving;
  const ownSlot = state.hasOwn(m.id);
  // Remove-only view (plan below the feature): no new picks, but a replacement
  // that is serving on the storefront can still be taken down.
  const removeOnly = !state.canReplace;

  const openReplace = () => {
    if (m.kind === "external") {
      setLinkValue("");
      setLinkError(false);
      setLinkOpen(true);
    } else {
      setPickerKind(m.kind);
    }
  };
  const closeLink = () => { setLinkOpen(false); setLinkValue(""); setLinkError(false); };

  return (
    <>
      <InlineStack gap="100" blockAlign="center">
        {!removeOnly && (
          <DisabledActionTooltip hint={blockedHint}>
            <Button size="slim" onClick={openReplace} disabled={disabled} loading={resolving}>{replaceLabel}</Button>
          </DisabledActionTooltip>
        )}
        {removeOnly && !ownSlot && (
          <Text as="span" variant="bodySm" tone="subdued">{tx.planRemoveOnly}</Text>
        )}
        {ownSlot && m.key && (
          <Button size="slim" tone="critical" disabled={disabled} onClick={() => state.draftRemove(m.id, m.kind)}>
            {removeLabel}
          </Button>
        )}
      </InlineStack>

      {pickerKind && (
        <FilePickerModal
          open
          onClose={() => setPickerKind(null)}
          onAdd={handlePicked}
          uploadCommitMode="queue"
          initialKind={pickerKind}
          imagesOnly={pickerKind === "image"}
          videosOnly={pickerKind === "video"}
          currentProductId={state.productId}
          title={(pickerKind === "video" ? tx.videoPickerTitle : tx.pickerTitle).replace("{locale}", languageName)}
        />
      )}

      {/* A YouTube/Vimeo original is replaced by another YouTube/Vimeo LINK:
          the storefront rewrites the player's embed address, so a file cannot
          stand in for it. Validated on the server again (the one parser). */}
      <Modal
        open={linkOpen}
        onClose={closeLink}
        title={tx.linkTitle.replace("{locale}", languageName)}
        primaryAction={{ content: tx.linkSave, onAction: handleLinkSave, disabled: !linkValue.trim() }}
        secondaryActions={[{ content: tx.linkCancel, onAction: closeLink }]}
      >
        <Modal.Section>
          <TextField
            label={tx.linkLabel}
            value={linkValue}
            onChange={(v) => { setLinkValue(v); setLinkError(false); }}
            autoComplete="off"
            placeholder="https://www.youtube.com/watch?v=…"
            helpText={tx.linkHelp}
            error={linkError ? tx.errors.invalidExternalUrl : undefined}
          />
        </Modal.Section>
      </Modal>
    </>
  );
}

/**
 * In the PRIMARY locale nothing of this feature renders, but drafts made in a
 * foreign language are still waiting behind the save bar: one subdued line says
 * so, or the bar would be dirty with no visible reason.
 */
function LocalizedMediaDraftsNote() {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const state = ctx?.state;
  if (!state || state.active || !state.hasDrafts) return null;
  const languages = state.draftLocales.map((l) => getLocalizedLanguageName(l, appLocale)).join(", ");
  return <Text as="p" variant="bodySm" tone="subdued">{t.localizedImages.draftsElsewhere.replace("{languages}", languages)}</Text>;
}

/**
 * Replacements nothing in the gallery can reach any more (original removed,
 * market inactive, language removed): a compact warning with a remove button
 * per row, foreign locale only, and ONLY while there are any. Removing is a
 * draft like everything else (the row stays, marked, with an undo, until the
 * save bar writes it).
 */
export function LocalizedMediaOrphanNotice() {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;
  const state = ctx?.state;
  if (ctx && state && !state.active) return <LocalizedMediaDraftsNote />;
  if (!ctx || !state || !state.active || state.orphans.length === 0) return null;
  return (
    <Banner tone="warning" title={tx.orphanTitle}>
      <BlockStack gap="200">
        <Text as="p">{tx.orphanDescription}</Text>
        {state.orphans.map((e) => {
          const key = `${e.m}|${e.l}|${e.k}`;
          const marketName = e.k ? state.markets.find((mk) => marketNumericId(mk.id) === e.k)?.name ?? e.k : tx.allMarkets;
          const pending = !!state.drafts[key];
          return (
            <InlineStack key={key} gap="200" blockAlign="center">
              <Text as="span" variant="bodySm" textDecorationLine={pending ? "line-through" : undefined}>
                {getLocalizedLanguageName(e.l, appLocale)} · {marketName}
              </Text>
              {pending ? (
                <>
                  <Text as="span" variant="bodySm" tone="subdued">{tx.removeOnSave}</Text>
                  <Button size="slim" variant="plain" disabled={state.saving} onClick={() => state.undoDraft(e.m, e.l, e.k)}>
                    {tx.undo}
                  </Button>
                </>
              ) : (
                <Button size="slim" variant="plain" tone="critical" disabled={state.saving} onClick={() => state.draftRemoveEntry(e)}>
                  {tx.remove}
                </Button>
              )}
            </InlineStack>
          );
        })}
      </BlockStack>
    </Banner>
  );
}

/**
 * Videos (and YouTube/Vimeo links) of the product as small selectable tiles, for
 * the PLAIN gallery, which only lists images: without them a video could not be
 * replaced while the image manager is off. Foreign locale only; the same button
 * and the same corner symbol as the image manager's gallery. Also carries the
 * orphan notice, so it shows for a product with no images too.
 */
export function LocalizedMediaPlainExtras() {
  const ctx = useLocalizedMediaContext();
  const { t } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const state = ctx?.state;
  if (ctx && state && !state.active) return <LocalizedMediaDraftsNote />;
  if (!ctx || !state || !state.active) return null;
  const videos = state.media.filter((m) => m.kind !== "image");
  const selectedId = selected && videos.some((m) => m.id === selected) ? selected : null;
  return (
    <BlockStack gap="300">
      {videos.length > 0 && (
        <BlockStack gap="200">
          <Text as="h4" variant="headingSm">{t.localizedImages.videosTitle}</Text>
          <InlineStack gap="200">
            {videos.map((m) => {
              const on = m.id === selectedId;
              const tile = state.tileOf(m.id);
              const src = tile?.src ?? m.url;
              return (
                // The symbol is a SIBLING of the tile button (a button inside a
                // button is invalid markup), positioned over it.
                <div key={m.id} style={{ position: "relative", width: 72, height: 72 }}>
                  <button
                    type="button"
                    aria-pressed={on}
                    title={tile?.title ?? m.alt ?? state.kindName(m.kind)}
                    onClick={() => setSelected(on ? null : m.id)}
                    style={{
                      position: "relative",
                      width: 72,
                      height: 72,
                      padding: 0,
                      cursor: "pointer",
                      overflow: "hidden",
                      background: "var(--p-color-bg-surface-secondary)",
                      border: on ? "3px solid #005bd3" : "2px solid var(--app-surface-border-color)",
                      borderRadius: 8,
                    }}
                  >
                    {src && <img src={`${src}${src.includes("?") ? "&" : "?"}width=160`} alt={m.alt ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                    <span aria-hidden style={{ position: "absolute", right: 4, bottom: 2, fontSize: 12, color: "#fff", textShadow: "0 0 3px #000" }}>▶</span>
                  </button>
                  {tile && (
                    <ReplacedMediaBadge label={tile.label} draft={tile.draft} showingOriginal={tile.showingOriginal} onToggle={tile.onToggle} />
                  )}
                </div>
              );
            })}
          </InlineStack>
          {selectedId && <LocalizedMediaReplaceButtons mediaId={selectedId} />}
        </BlockStack>
      )}
      <LocalizedMediaOrphanNotice />
    </BlockStack>
  );
}
