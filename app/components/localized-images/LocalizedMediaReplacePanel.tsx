/**
 * The replacement of ONE selected product medium for the language (and market)
 * the editor is showing — inline in the gallery, no card of its own.
 *
 * Renders only while a foreign language is active: in the primary locale there
 * is nothing special at all. Rendered by BOTH galleries (the image manager's
 * product gallery and the plain ImageGalleryField) for their one selected
 * medium; the state lives in LocalizedMediaContext.
 */
import { useCallback, useState } from "react";
import { ReplacedMediaBadge } from "./ReplacedMediaBadge";
import { Badge, Banner, BlockStack, Button, InlineStack, Modal, Spinner, Text, TextField } from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useI18n } from "../../contexts/I18nContext";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { resolvePickedMedia } from "./resolve-picked-image";
import { marketNumericId, resolveLocalizedMedia } from "../../services/localized-media/localized-media.shared";
import { useLocalizedMediaContext } from "./LocalizedMediaContext";

const thumbBox: React.CSSProperties = {
  width: 72,
  height: 72,
  flex: "0 0 72px",
  border: "1px solid var(--app-surface-border-color)",
  borderRadius: "var(--app-field-border-radius)",
  overflow: "hidden",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--p-color-bg-surface-secondary)",
  position: "relative",
};

function Thumb({ url, label, video = false }: { url: string | null; label: string; video?: boolean }) {
  return (
    <div style={thumbBox}>
      {url ? (
        <img src={`${url}${url.includes("?") ? "&" : "?"}width=160`} alt={label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      ) : (
        <Text as="span" variant="bodySm" tone="subdued">{video ? "▶" : "—"}</Text>
      )}
      {video && url && (
        <span aria-hidden style={{ position: "absolute", right: 4, bottom: 2, fontSize: 12, color: "#fff", textShadow: "0 0 3px #000" }}>▶</span>
      )}
    </div>
  );
}

export function LocalizedMediaReplacePanel({ mediaId }: { mediaId: string }) {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;
  const [pickerKind, setPickerKind] = useState<"image" | "video" | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState("");
  // Between choosing a file and the write: a fresh upload is materialised first.
  const [resolving, setResolving] = useState(false);

  const state = ctx?.state;
  const setFile = state?.setFile;
  const reportFailure = state?.reportFailure;
  const setLink = state?.setLink;

  const handlePicked = useCallback(async (items: AddedItem[]) => {
    const kind = pickerKind;
    setPickerKind(null);
    if (!kind || !setFile || !reportFailure) return;
    setResolving(true);
    try {
      const picked = await resolvePickedMedia(items.find((i) => i.source !== "external_url") ?? items[0], kind);
      if ("error" in picked) {
        reportFailure(mediaId, picked.code, picked.error);
        return;
      }
      await setFile(mediaId, picked.fileId);
    } finally {
      setResolving(false);
    }
  }, [pickerKind, setFile, reportFailure, mediaId]);

  const handleLinkSave = useCallback(async () => {
    const externalUrl = linkValue.trim();
    setLinkOpen(false);
    setLinkValue("");
    if (!externalUrl || !setLink) return;
    await setLink(mediaId, externalUrl);
  }, [linkValue, setLink, mediaId]);

  // Primary locale, below the plan, or not a product page: nothing at all.
  if (!ctx || !state || !state.active) return null;

  const languageName = getLocalizedLanguageName(state.rawLocale, appLocale);
  const title = state.marketName
    ? tx.panelTitleMarket.replace("{language}", languageName).replace("{market}", state.marketName)
    : tx.panelTitle.replace("{language}", languageName);
  const box: React.CSSProperties = {
    marginTop: 10,
    padding: "10px 12px",
    border: "1px solid var(--app-surface-border-color)",
    borderRadius: "var(--app-field-border-radius)",
  };

  if (state.loading && !state.loaded) {
    return <div style={box}><InlineStack gap="200" blockAlign="center"><Spinner size="small" /><Text as="span" tone="subdued">{title}</Text></InlineStack></div>;
  }
  if (state.loadError && !state.loaded) {
    return (
      <div style={box}>
        <Banner tone="warning" action={{ content: tx.retry, onAction: () => void state.load() }}>
          <Text as="p">{tx.loadFailed}</Text>
        </Banner>
      </div>
    );
  }

  const m = state.mediaById.get(mediaId);
  if (!m) {
    // Saved on Shopify but not reported yet (still processing), or added after
    // the last read: said, never silently offered.
    return (
      <div style={box}>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">{tx.notYetAvailable}</Text>
          <Button size="slim" variant="plain" loading={state.loading} onClick={() => void state.load()}>{tx.retry}</Button>
        </InlineStack>
      </div>
    );
  }

  const hit = resolveLocalizedMedia(state.entries, m.id, state.locale, state.marketNumeric);
  const ownSlot = !!hit && !hit.inherited;
  const stale = !!hit && !!hit.entry.s && hit.entry.s !== m.stamp;
  const busy = state.busySlot === m.id || resolving;
  const anyBusy = state.busySlot !== null || resolving;
  const isVideo = m.kind !== "image";
  // A medium whose storefront key could not be derived cannot be swapped on the
  // storefront, so it is not offered — said, not hidden.
  const blockedHint = m.key ? undefined : tx.cannotReplace;
  const replaceLabel = m.kind === "external" ? tx.replaceLink : m.kind === "video" ? tx.replaceVideo : tx.replace;
  const notice = state.notice && state.notice.scope === "panel" && state.notice.mediaId === mediaId ? state.notice : null;

  const openReplace = () => {
    if (m.kind === "external") {
      setLinkValue("");
      setLinkOpen(true);
    } else {
      setPickerKind(m.kind);
    }
  };

  return (
    <div style={box}>
      <BlockStack gap="200">
        <Text as="h4" variant="headingSm">{title}</Text>
        <InlineStack gap="300" blockAlign="center" wrap={false}>
          <Thumb url={m.url || null} label={tx.original} video={isVideo} />
          <Text as="span" tone="subdued">→</Text>
          <Thumb url={hit ? hit.entry.u || null : null} label={tx.replacement} video={isVideo && !!hit} />
          <BlockStack gap="100">
            <InlineStack gap="100">
              {m.kind === "video" && <Badge>{tx.badgeVideo}</Badge>}
              {m.kind === "external" && <Badge>{tx.badgeExternal}</Badge>}
              {hit?.inherited && <Badge>{tx.inherited}</Badge>}
              {hit?.entry.a === "ai" && <Badge tone="info">{tx.aiOrigin}</Badge>}
            </InlineStack>
            {!hit && <Text as="p" variant="bodySm" tone="subdued">{tx.usingOriginal}</Text>}
            {stale && <Text as="p" variant="bodySm" tone="caution">{tx.staleOriginal}</Text>}
            {hit?.entry.x && !hit.entry.u && <Text as="p" variant="bodySm" tone="subdued">{tx.posterKept}</Text>}
            <InlineStack gap="200" blockAlign="center">
              <DisabledActionTooltip hint={blockedHint}>
                <Button size="slim" onClick={openReplace} disabled={!m.key || anyBusy} loading={busy}>
                  {ownSlot ? tx.change : replaceLabel}
                </Button>
              </DisabledActionTooltip>
              {ownSlot && (
                <Button size="slim" variant="plain" tone="critical" disabled={anyBusy} onClick={() => void state.removeOwn(m.id)}>
                  {tx.remove}
                </Button>
              )}
            </InlineStack>
          </BlockStack>
        </InlineStack>

        {notice && (
          <Banner tone={notice.tone} onDismiss={() => state.setNotice(null)}><Text as="p">{notice.text}</Text></Banner>
        )}

        <Text as="p" variant="bodySm" tone="subdued">{tx.panelHint}</Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">{tx.embedHint}</Text>
          {ctx.embedActivationUrl && (
            <Button variant="plain" url={ctx.embedActivationUrl} target="_blank">{tx.openEmbed}</Button>
          )}
        </InlineStack>
      </BlockStack>

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
          stand in for it. Validated on the server (the one parser). */}
      <Modal
        open={linkOpen}
        onClose={() => { setLinkOpen(false); setLinkValue(""); }}
        title={tx.linkTitle.replace("{locale}", languageName)}
        primaryAction={{ content: tx.linkSave, onAction: () => void handleLinkSave(), disabled: !linkValue.trim() }}
        secondaryActions={[{ content: tx.linkCancel, onAction: () => { setLinkOpen(false); setLinkValue(""); } }]}
      >
        <Modal.Section>
          <TextField
            label={tx.linkLabel}
            value={linkValue}
            onChange={setLinkValue}
            autoComplete="off"
            placeholder="https://www.youtube.com/watch?v=…"
            helpText={tx.linkHelp}
          />
        </Modal.Section>
      </Modal>
    </div>
  );
}

/**
 * Replacements nothing in the gallery can reach any more (original removed,
 * market inactive, language removed): listed with a remove button, foreign
 * locale only, below the gallery.
 */
export function LocalizedMediaOrphanNotice() {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;
  const state = ctx?.state;
  if (!ctx || !state || !state.active || state.orphans.length === 0) return null;
  const notice = state.notice && state.notice.scope === "orphan" ? state.notice : null;
  return (
    <Banner tone="warning" title={tx.orphanTitle}>
      <BlockStack gap="200">
        <Text as="p">{tx.orphanDescription}</Text>
        {state.orphans.map((e) => {
          const slot = `${e.m}|${e.l}|${e.k}`;
          const marketName = e.k ? state.markets.find((mk) => marketNumericId(mk.id) === e.k)?.name ?? e.k : tx.allMarkets;
          return (
            <InlineStack key={slot} gap="200" blockAlign="center">
              <Thumb url={e.u || null} label="" video={!!e.x} />
              <Text as="span" variant="bodySm">{getLocalizedLanguageName(e.l, appLocale)} · {marketName}</Text>
              <Button size="slim" variant="plain" tone="critical" disabled={state.busySlot !== null} onClick={() => void state.removeEntry(e)}>
                {tx.remove}
              </Button>
            </InlineStack>
          );
        })}
        {notice && <Text as="p" variant="bodySm" tone={notice.tone === "critical" ? "critical" : "success"}>{notice.text}</Text>}
      </BlockStack>
    </Banner>
  );
}

/**
 * Videos (and YouTube/Vimeo links) of the product as small selectable tiles, for
 * the PLAIN gallery, which only lists images: without them a video could not be
 * replaced while the image manager is off. Foreign locale only; the same panel
 * and the same corner mark as the image manager's gallery. Also carries the
 * orphan notice, so it shows for a product with no images too.
 */
export function LocalizedMediaPlainExtras() {
  const ctx = useLocalizedMediaContext();
  const { t, locale: appLocale } = useI18n();
  const [selected, setSelected] = useState<string | null>(null);
  const state = ctx?.state;
  if (!ctx || !state || !state.active) return null;
  const videos = state.media.filter((m) => m.kind !== "image");
  const selectedId = selected && videos.some((m) => m.id === selected) ? selected : null;
  const mark = t.localizedImages.replacedMark.replace("{language}", getLocalizedLanguageName(state.rawLocale, appLocale));
  return (
    <BlockStack gap="300">
      {videos.length > 0 && (
        <BlockStack gap="200">
          <Text as="h4" variant="headingSm">{t.localizedImages.videosTitle}</Text>
          <InlineStack gap="200">
            {videos.map((m) => {
              const on = m.id === selectedId;
              return (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={on}
                  title={m.alt ?? m.kind}
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
                  {m.url && <img src={`${m.url}${m.url.includes("?") ? "&" : "?"}width=160`} alt={m.alt ?? ""} style={{ width: "100%", height: "100%", objectFit: "cover" }} />}
                  <span aria-hidden style={{ position: "absolute", right: 4, bottom: 2, fontSize: 12, color: "#fff", textShadow: "0 0 3px #000" }}>▶</span>
                  {state.replaced.has(m.id) && <ReplacedMediaBadge label={mark} />}
                </button>
              );
            })}
          </InlineStack>
          {selectedId && <LocalizedMediaReplacePanel mediaId={selectedId} />}
        </BlockStack>
      )}
      <LocalizedMediaOrphanNotice />
    </BlockStack>
  );
}
