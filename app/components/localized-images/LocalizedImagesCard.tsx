/**
 * "Images per language" on the product page (PLAN_LOCALIZED_IMAGES Phase 1b):
 * for each of the product's images, a 1:1 replacement per language and,
 * optionally, per market.
 *
 * Unlike the editor's fields this is NOT a draft behind the save bar: every
 * choice is one confirmed write of its own (like adding an image in the image
 * manager beside it), because the thing being changed is the product's
 * storefront media, not a text the save bar collects. What the card shows is
 * always the server's answer after the write, never the client's hope.
 *
 * Everything is read LIVE (the metafield is the one store — see
 * localized-media.shared.ts), so the card loads on its own and says so when
 * that fails instead of showing "nothing replaced".
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineGrid,
  InlineStack,
  Modal,
  Select,
  Spinner,
  Text,
  TextField,
} from "@shopify/polaris";
import { FilePickerModal, type AddedItem } from "../image-manager/FilePickerModal";
import { DisabledActionTooltip } from "../DisabledActionTooltip";
import { useI18n } from "../../contexts/I18nContext";
import { getLocalizedLanguageName } from "../../utils/contentEditor.utils";
import { resolvePickedMedia } from "./resolve-picked-image";
import {
  marketNumericId,
  normalizeLocale,
  resolveLocalizedMedia,
  type LocalizedMediaEntry,
} from "../../services/localized-media/localized-media.shared";
import type { MarketInfo, ShopLocale } from "../../types/content-editor.types";

/** One product medium as /api/localized-images reports it (ProductMediaItem). */
interface MediaItem {
  id: string;
  kind: "image" | "video" | "external";
  url: string;
  alt: string | null;
  /** Null = the storefront key could not be derived; such a medium is listed but not replaceable. */
  key: string | null;
  poster: string;
  stamp: string;
}

export interface LocalizedImagesCardProps {
  productId: string;
  shopLocales: ShopLocale[];
  markets: MarketInfo[];
  currentLanguage?: string;
  /** Theme-editor deep link that activates the storefront embed; null hides the button. */
  embedActivationUrl?: string | null;
}

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
};

function Thumb({ url, label, video = false }: { url: string | null; label: string; video?: boolean }) {
  return (
    <div style={{ ...thumbBox, position: "relative" }}>
      {url ? (
        <img src={`${url}${url.includes("?") ? "&" : "?"}width=160`} alt={label} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
      ) : (
        <Text as="span" variant="bodySm" tone="subdued">{video ? "▶" : "—"}</Text>
      )}
      {video && url && (
        <span style={{ position: "absolute", right: 4, bottom: 2, fontSize: 12, color: "#fff", textShadow: "0 0 3px #000" }}>▶</span>
      )}
    </div>
  );
}

export function LocalizedImagesCard({ productId, shopLocales, markets, currentLanguage, embedActivationUrl }: LocalizedImagesCardProps) {
  const { t, locale: appLocale } = useI18n();
  const tx = t.localizedImages;

  const foreignLocales = useMemo(() => shopLocales.filter((l) => !l.primary), [shopLocales]);
  // Single-language shop: the card stays visible and says why it cannot be
  // used (CLAUDE.md: disable + explain, never hide what exists). An EMPTY
  // list is a failed lookup, which counts as multi-language.
  const singleLocaleHint = shopLocales.length === 1 ? t.common.requiresSecondLanguage : undefined;

  const [locale, setLocale] = useState<string>(() => {
    const cur = foreignLocales.find((l) => l.locale === currentLanguage);
    return cur?.locale ?? foreignLocales[0]?.locale ?? "";
  });
  useEffect(() => {
    if (currentLanguage && foreignLocales.some((l) => l.locale === currentLanguage)) setLocale(currentLanguage);
  }, [currentLanguage, foreignLocales]);
  useEffect(() => {
    if (!foreignLocales.some((l) => l.locale === locale)) setLocale(foreignLocales[0]?.locale ?? "");
  }, [foreignLocales, locale]);

  const [marketId, setMarketId] = useState<string>("");
  const marketNumeric = marketNumericId(marketId) ?? "";

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [entries, setEntries] = useState<LocalizedMediaEntry[]>([]);
  const [media, setMedia] = useState<MediaItem[]>([]);
  const [busySlot, setBusySlot] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "critical"; text: string } | null>(null);
  // Which original the file picker (an image or a Shopify video) or the link
  // dialog (a YouTube/Vimeo video) is open for.
  const [pickerFor, setPickerFor] = useState<{ id: string; kind: "image" | "video" } | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [linkValue, setLinkValue] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const res = await fetch(`/api/localized-images?productId=${encodeURIComponent(productId)}`);
      const body = (await res.json()) as { ok?: boolean; entries?: LocalizedMediaEntry[]; media?: MediaItem[] };
      if (!res.ok || !body.ok) throw new Error("load");
      setEntries(body.entries ?? []);
      setMedia(body.media ?? []);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    setNotice(null);
    void load();
  }, [load]);

  // The route answers with machine codes; the merchant reads sentences.
  const errorText = useCallback((code: string | undefined, fallback: string) => {
    const known = code ? (tx.errors as Record<string, string>)[code] : undefined;
    return known ?? tx.saveFailed.replace("{error}", fallback);
  }, [tx]);

  const post = useCallback(async (payload: Record<string, unknown>, slot: string, okText: string) => {
    setBusySlot(slot);
    setNotice(null);
    try {
      const res = await fetch("/api/localized-images", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId, ...payload }),
      });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; entries?: LocalizedMediaEntry[]; media?: MediaItem[]; code?: string; message?: string };
      if (!res.ok || !body.ok) {
        setNotice({ tone: "critical", text: errorText(body.code, body.message || `HTTP ${res.status}`) });
        return;
      }
      if (body.entries) setEntries(body.entries);
      if (body.media) setMedia(body.media);
      setNotice({ tone: "success", text: okText });
    } catch (e) {
      setNotice({ tone: "critical", text: tx.saveFailed.replace("{error}", e instanceof Error ? e.message : String(e)) });
    } finally {
      setBusySlot(null);
    }
  }, [productId, tx, errorText]);

  const handlePicked = useCallback(async (items: AddedItem[]) => {
    const target = pickerFor;
    setPickerFor(null);
    if (!target) return;
    const sourceMediaId = target.id;
    setBusySlot(sourceMediaId);
    const picked = await resolvePickedMedia(items.find((i) => i.source !== "external_url") ?? items[0], target.kind);
    if ("error" in picked) {
      setBusySlot(null);
      setNotice({ tone: "critical", text: errorText(picked.code, picked.error) });
      return;
    }
    await post({ intent: "set", sourceMediaId, locale, marketId, fileId: picked.fileId }, sourceMediaId, tx.saved);
  }, [pickerFor, post, locale, marketId, errorText]);

  const handleLinkSave = useCallback(async () => {
    const sourceMediaId = linkFor;
    const externalUrl = linkValue.trim();
    setLinkFor(null);
    setLinkValue("");
    if (!sourceMediaId || !externalUrl) return;
    await post({ intent: "set", sourceMediaId, locale, marketId, externalUrl }, sourceMediaId, tx.saved);
  }, [linkFor, linkValue, post, locale, marketId, tx]);

  const openReplace = useCallback((m: MediaItem) => {
    if (m.kind === "external") {
      setLinkValue("");
      setLinkFor(m.id);
    } else {
      setPickerFor({ id: m.id, kind: m.kind });
    }
  }, []);

  const mediaIds = useMemo(() => new Set(media.map((m) => m.id)), [media]);
  const orphans = useMemo(() => entries.filter((e) => !mediaIds.has(e.m)), [entries, mediaIds]);
  const countFor = useCallback(
    (loc: string) => entries.filter((e) => e.l === normalizeLocale(loc) && mediaIds.has(e.m)).length,
    [entries, mediaIds],
  );

  const languageOptions = foreignLocales.map((l) => {
    const n = countFor(l.locale);
    const name = getLocalizedLanguageName(l.locale, appLocale, l.name);
    return { label: n ? `${name} (${tx.replacedCount.replace("{n}", String(n))})` : name, value: l.locale };
  });
  const marketOptions = [{ label: tx.allMarkets, value: "" }, ...markets.map((m) => ({ label: m.name, value: m.id }))];
  const disabled = !!singleLocaleHint || !locale;

  return (
    <Card>
      <BlockStack gap="300">
        <Text as="h3" variant="headingSm">{tx.cardTitle}</Text>
        <Text as="p" tone="subdued">{tx.cardDescription}</Text>
        <InlineStack gap="200" blockAlign="center">
          <Text as="p" variant="bodySm" tone="subdued">{tx.embedHint}</Text>
          {embedActivationUrl && (
            <Button variant="plain" url={embedActivationUrl} target="_blank">{tx.openEmbed}</Button>
          )}
        </InlineStack>

        {singleLocaleHint ? (
          <Banner tone="info"><Text as="p">{singleLocaleHint}</Text></Banner>
        ) : (
          <InlineGrid columns={{ xs: 1, sm: 2 }} gap="300">
            <Select label={tx.language} options={languageOptions} value={locale} onChange={setLocale} disabled={disabled} />
            {markets.length > 0 && (
              <Select label={tx.market} options={marketOptions} value={marketId} onChange={setMarketId} disabled={disabled} />
            )}
          </InlineGrid>
        )}

        {notice && (
          <Banner tone={notice.tone} onDismiss={() => setNotice(null)}><Text as="p">{notice.text}</Text></Banner>
        )}

        {loading ? (
          <InlineStack align="center"><Spinner size="small" /></InlineStack>
        ) : loadError ? (
          <Banner tone="warning" action={{ content: tx.retry, onAction: () => void load() }}>
            <Text as="p">{tx.loadFailed}</Text>
          </Banner>
        ) : media.length === 0 ? (
          <Text as="p" tone="subdued">{tx.noMedia}</Text>
        ) : (
          <BlockStack gap="200">
            {media.map((m) => {
              const hit = locale ? resolveLocalizedMedia(entries, m.id, locale, marketNumeric) : null;
              const ownSlot = hit && !hit.inherited;
              const stale = !!hit && !!hit.entry.s && hit.entry.s !== m.stamp;
              const busy = busySlot === m.id;
              const isVideo = m.kind !== "image";
              // A medium whose storefront key could not be derived cannot be
              // swapped on the storefront, so it is not offered — said, not hidden.
              const blockedHint = singleLocaleHint ?? (m.key ? undefined : tx.cannotReplace);
              return (
                <InlineStack key={m.id} gap="300" blockAlign="center" wrap={false}>
                  <Thumb url={m.url || null} label={m.alt ?? ""} video={isVideo} />
                  <Text as="span" tone="subdued">→</Text>
                  <Thumb url={hit ? hit.entry.u || null : null} label="" video={isVideo && !!hit} />
                  <BlockStack gap="100">
                    <InlineStack gap="100">
                      {m.kind === "video" && <Badge>{tx.badgeVideo}</Badge>}
                      {m.kind === "external" && <Badge>{tx.badgeExternal}</Badge>}
                      {hit?.inherited && <Badge>{tx.inherited}</Badge>}
                      {hit?.entry.a === "ai" && <Badge tone="info">{tx.aiOrigin}</Badge>}
                    </InlineStack>
                    {stale && <Text as="p" variant="bodySm" tone="caution">{tx.staleOriginal}</Text>}
                    {hit?.entry.x && !hit.entry.u && <Text as="p" variant="bodySm" tone="subdued">{tx.posterKept}</Text>}
                    <InlineStack gap="200">
                      <DisabledActionTooltip hint={blockedHint}>
                        <Button size="slim" onClick={() => openReplace(m)} disabled={disabled || !m.key || busySlot !== null} loading={busy}>
                          {ownSlot ? tx.change : tx.replace}
                        </Button>
                      </DisabledActionTooltip>
                      {ownSlot && (
                        <Button
                          size="slim"
                          variant="plain"
                          tone="critical"
                          disabled={busySlot !== null}
                          onClick={() => void post({ intent: "remove", sourceMediaId: m.id, locale, marketId }, m.id, tx.removedToast)}
                        >
                          {tx.remove}
                        </Button>
                      )}
                    </InlineStack>
                  </BlockStack>
                </InlineStack>
              );
            })}
          </BlockStack>
        )}

        {orphans.length > 0 && (
          <Banner tone="warning" title={tx.orphanTitle}>
            <BlockStack gap="200">
              <Text as="p">{tx.orphanDescription}</Text>
              {orphans.map((e) => {
                const slot = `${e.m}|${e.l}|${e.k}`;
                const marketName = e.k ? markets.find((mk) => marketNumericId(mk.id) === e.k)?.name ?? e.k : tx.allMarkets;
                return (
                  <InlineStack key={slot} gap="200" blockAlign="center">
                    <Thumb url={e.u || null} label="" video={!!e.x} />
                    <Text as="span" variant="bodySm">
                      {getLocalizedLanguageName(e.l, appLocale)} · {marketName}
                    </Text>
                    <Button
                      size="slim"
                      variant="plain"
                      tone="critical"
                      disabled={busySlot !== null}
                      onClick={() => {
                        const gid = e.k ? `gid://shopify/Market/${e.k}` : "";
                        void post({ intent: "remove", sourceMediaId: e.m, locale: e.l, marketId: gid }, slot, tx.removedToast);
                      }}
                    >
                      {tx.remove}
                    </Button>
                  </InlineStack>
                );
              })}
            </BlockStack>
          </Banner>
        )}
      </BlockStack>

      {pickerFor && (
        <FilePickerModal
          open={!!pickerFor}
          onClose={() => setPickerFor(null)}
          onAdd={handlePicked}
          uploadCommitMode="queue"
          initialKind={pickerFor.kind}
          imagesOnly={pickerFor.kind === "image"}
          videosOnly={pickerFor.kind === "video"}
          currentProductId={productId}
          title={(pickerFor.kind === "video" ? tx.videoPickerTitle : tx.pickerTitle).replace("{locale}", getLocalizedLanguageName(locale, appLocale))}
        />
      )}

      {/* A YouTube/Vimeo original is replaced by another YouTube/Vimeo LINK —
          the storefront rewrites the player's embed address, so a file
          cannot stand in for it. Validated on the server (the one parser). */}
      <Modal
        open={linkFor !== null}
        onClose={() => { setLinkFor(null); setLinkValue(""); }}
        title={tx.linkTitle.replace("{locale}", getLocalizedLanguageName(locale, appLocale))}
        primaryAction={{ content: tx.linkSave, onAction: () => void handleLinkSave(), disabled: !linkValue.trim() }}
        secondaryActions={[{ content: tx.linkCancel, onAction: () => { setLinkFor(null); setLinkValue(""); } }]}
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
    </Card>
  );
}
