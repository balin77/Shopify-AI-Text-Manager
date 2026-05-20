import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import {
  Modal,
  TextField,
  ButtonGroup,
  Button,
  Spinner,
  Text,
  Banner,
  InlineStack,
  BlockStack,
  Divider,
  Checkbox,
  Select,
} from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import { classifyFile, parseExternalVideoUrl, ALL_UPLOADABLE_MIME_TYPES } from "../../utils/mediaKind";
import type { MediaKind } from "./types";

/**
 * Single source for "add media to this gallery". Replaces three separate
 * entry points (file-picker click on a placeholder, the standalone
 * `Browse existing files` button, the YouTube/Vimeo URL row) with one modal.
 *
 * Drives the rest of the Image Manager via three independent callbacks
 * (onAdd / onAddExternalUrl) so the parent can route library picks,
 * fresh uploads and external URLs into the right pending-state slot
 * depending on whether the modal was opened from the product gallery or
 * from a specific variant section.
 */

export type AddedItem =
  | {
      /** Already in the merchant's Shopify Files library — committed as
       *  a list.file_reference GID. */
      source: "library";
      gid: string;
      kind: MediaKind;
      previewUrl: string;
      alt: string | null;
    }
  | {
      /** Just uploaded via stagedUploadsCreate; the resourceUrl is the
       *  signed CDN target. The backend will materialize it into a
       *  Shopify Media GID via productCreateMedia at save time. */
      source: "upload";
      resourceUrl: string;
      kind: MediaKind;
      previewUrl: string;
      fileName: string;
      mimeType: string;
    };

interface ApiFile {
  kind: MediaKind;
  id: string;
  previewUrl: string;
  reference: string;
  alt: string | null;
}

interface ProductListItem {
  id: string;
  title: string;
  featuredImageUrl: string | null;
}

interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Modal commits the picked / uploaded items via this callback.
   *  In "queue" mode it is called once when the merchant hits the footer's
   *  Add button. In "immediate" mode it is called each time an upload
   *  completes (so uploaded files land on the variant instantly). */
  onAdd: (items: AddedItem[]) => void;
  /** Optional — when omitted the URL row is hidden. Called the moment the
   *  merchant hits "Add link" on a valid URL; the modal stays open so they
   *  can pile on more without re-opening. */
  onAddExternalUrl?: (url: string) => void;
  /** "queue" = behaviour merchants know from a typical file-picker (upload,
   *  then click an Add button). Used by the product gallery placeholder.
   *  "immediate" = upload-and-assign in one motion. Used by variant
   *  placeholders where the merchant's intent is clearly "this variant". */
  uploadCommitMode: "queue" | "immediate";
  initialKind?: "all" | "image" | "video" | "model";
  /** Product GID currently in focus — drives the "in this product" toggle
   *  and lets the dropdown skip itself in the "other product" list. */
  currentProductId?: string;
  /** Override the modal's heading. Defaults to a generic "Add media" string;
   *  callers typically inject "Add to [variant title]" for clarity. */
  title?: string;
}

type KindFilter = "all" | "image" | "video" | "model";

const PAGE_SIZE = 60;
const UPLOAD_ACCEPT = [
  ...ALL_UPLOADABLE_MIME_TYPES,
  ".glb",
  ".gltf",
].join(",");

interface PendingUpload {
  uniqueId: string;
  fileName: string;
  mimeType: string;
  kind: MediaKind;
  previewUrl: string;
  resourceUrl: string;
  progress: number;
  status: "uploading" | "ready" | "error";
}

export function FilePickerModal({
  open,
  onClose,
  onAdd,
  onAddExternalUrl,
  uploadCommitMode,
  initialKind = "all",
  currentProductId,
  title,
}: FilePickerModalProps) {
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>(initialKind);
  // Product filter: "all" = library-wide, "current" = currentProductId,
  // "other:<gid>" = a specific other product selected via the dropdown.
  const [productScope, setProductScope] = useState<string>("all");
  const [otherProductSearch, setOtherProductSearch] = useState("");
  const [otherProducts, setOtherProducts] = useState<ProductListItem[]>([]);
  const [otherProductsLoading, setOtherProductsLoading] = useState(false);

  const [files, setFiles] = useState<ApiFile[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);

  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset on (re-)open so a stale selection / uploads from a previous open
  // cannot accidentally be re-committed.
  useEffect(() => {
    if (open) {
      setQuery("");
      setKind(initialKind);
      setProductScope("all");
      setOtherProductSearch("");
      setOtherProducts([]);
      setSelected(new Set());
      setError(null);
      setEndCursor(null);
      setHasNextPage(false);
      setFiles([]);
      setPendingUploads([]);
      setUrlInput("");
      setUrlError(null);
    }
  }, [open, initialKind]);

  // ------------------------------------------------------------------------
  // File-list fetching
  // ------------------------------------------------------------------------
  const usedByProductId = useMemo(() => {
    if (productScope === "all") return null;
    if (productScope === "current") return currentProductId ?? null;
    if (productScope.startsWith("other:")) return productScope.slice("other:".length);
    return null;
  }, [productScope, currentProductId]);

  const fetchFiles = useCallback(async (opts: { append: boolean }) => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (kind !== "all") params.set("kind", kind);
      params.set("first", String(PAGE_SIZE));
      if (opts.append && endCursor) params.set("after", endCursor);
      if (usedByProductId) params.set("usedByProductId", usedByProductId);
      const res = await fetch(`/api/files?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed (${res.status})`);
      const data = await res.json();
      const incoming: ApiFile[] = data.files ?? [];
      setFiles(prev => (opts.append ? [...prev, ...incoming] : incoming));
      setEndCursor(data.pageInfo?.endCursor ?? null);
      setHasNextPage(Boolean(data.pageInfo?.hasNextPage));
    } catch (err: any) {
      setError(err?.message ?? "Could not load files");
    } finally {
      setIsLoading(false);
    }
  }, [query, kind, endCursor, usedByProductId]);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setEndCursor(null);
      fetchFiles({ append: false });
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, kind, productScope]);

  // ------------------------------------------------------------------------
  // Other-product dropdown population (lazy on first interaction)
  // ------------------------------------------------------------------------
  const loadOtherProducts = useCallback(async (q: string) => {
    setOtherProductsLoading(true);
    try {
      const params = new URLSearchParams();
      if (q.trim()) params.set("q", q.trim());
      params.set("first", "100");
      const res = await fetch(`/api/products-list?${params.toString()}`);
      const data = await res.json();
      const list: ProductListItem[] = data.products ?? [];
      // Filter out the current product — that's what the "current" toggle
      // covers; showing it twice would be confusing.
      const filtered = currentProductId ? list.filter(p => p.id !== currentProductId) : list;
      setOtherProducts(filtered);
    } catch {
      // Silent: dropdown stays empty, merchant can still use Search + toggle.
    } finally {
      setOtherProductsLoading(false);
    }
  }, [currentProductId]);

  useEffect(() => {
    if (!open) return;
    loadOtherProducts(otherProductSearch);
  }, [open, otherProductSearch, loadOtherProducts]);

  // ------------------------------------------------------------------------
  // Upload pipeline (mirrors BulkImageUploadPanel's flow, inlined here so the
  // modal can drive its own progress UI and commit-on-complete behaviour).
  // ------------------------------------------------------------------------
  const handleFilesChosen = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const accepted = Array.from(fileList).filter(f => classifyFile(f.type, f.name) !== null);
    if (accepted.length === 0) return;

    const newItems: PendingUpload[] = accepted.map(f => {
      const itemKind = classifyFile(f.type, f.name) ?? "image";
      return {
        uniqueId: crypto.randomUUID(),
        fileName: f.name,
        mimeType: f.type,
        kind: itemKind,
        // GLB / unknown → no in-browser preview; the tile will fall back to
        // the same "3D" placeholder the gallery uses.
        previewUrl: itemKind === "model" ? "" : URL.createObjectURL(f),
        resourceUrl: "",
        progress: 0,
        status: "uploading" as const,
      };
    });

    setPendingUploads(prev => [...prev, ...newItems]);
    // In queue mode each upload is pre-selected so the merchant only needs
    // to hit the footer Add button once for a whole drop.
    if (uploadCommitMode === "queue") {
      setSelected(prev => {
        const next = new Set(prev);
        for (const it of newItems) next.add(it.uniqueId);
        return next;
      });
    }

    await Promise.all(accepted.map(async (file, i) => {
      const item = newItems[i];
      try {
        const res = await fetch("/api/staged-upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ filename: file.name, mimeType: file.type, fileSize: file.size }),
        });
        const stagedJson = await res.json();
        const { url, resourceUrl, error: stagedErr } = stagedJson;
        if (stagedJson?.code === "IMAGE_QUOTA_EXCEEDED") {
          setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
          setError(t.imageManager.imageQuotaExceeded?.replace("{limit}", String(stagedJson.limit ?? "")) ?? "Quota exceeded");
          return;
        }
        if (stagedErr || !url) {
          setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
          return;
        }
        await new Promise<void>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.upload.onprogress = (e) => {
            if (e.lengthComputable) {
              const pct = Math.round((e.loaded / e.total) * 100);
              setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, progress: pct } : it));
            }
          };
          xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) {
              setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId
                ? { ...it, status: "ready" as const, progress: 100, resourceUrl }
                : it));
              // In immediate mode commit the freshly uploaded file the moment
              // it's ready so the merchant sees it on the variant without an
              // extra click. We pull the latest snapshot via the setter
              // callback to avoid stale-closure issues if multiple uploads
              // finish out of order.
              if (uploadCommitMode === "immediate") {
                onAdd([{
                  source: "upload",
                  resourceUrl,
                  kind: item.kind,
                  previewUrl: item.previewUrl,
                  fileName: item.fileName,
                  mimeType: item.mimeType,
                }]);
                setPendingUploads(prev => prev.filter(p => p.uniqueId !== item.uniqueId));
              }
              resolve();
            } else {
              setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
              reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => {
            setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
            reject(new Error("Upload network error"));
          };
          xhr.open("PUT", url);
          xhr.setRequestHeader("Content-Type", file.type);
          xhr.send(file);
        });
      } catch {
        setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
      }
    }));
  }, [uploadCommitMode, onAdd, t]);

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // ------------------------------------------------------------------------
  // External URL handling
  // ------------------------------------------------------------------------
  const handleAddUrl = useCallback(() => {
    if (!onAddExternalUrl) return;
    const parsed = parseExternalVideoUrl(urlInput);
    if (!parsed) {
      setUrlError(t.imageManager.externalVideoInvalid ?? "Not a recognised YouTube or Vimeo URL.");
      return;
    }
    onAddExternalUrl(parsed.canonicalUrl);
    setUrlInput("");
    setUrlError(null);
  }, [urlInput, onAddExternalUrl, t]);

  // ------------------------------------------------------------------------
  // Selection + commit
  // ------------------------------------------------------------------------
  const toggleSelected = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleCommitSelected = useCallback(() => {
    const picked: AddedItem[] = [];
    for (const f of files) {
      if (selected.has(f.id)) {
        picked.push({ source: "library", gid: f.reference, kind: f.kind, previewUrl: f.previewUrl, alt: f.alt });
      }
    }
    for (const u of pendingUploads) {
      if (selected.has(u.uniqueId) && u.status === "ready" && u.resourceUrl) {
        picked.push({ source: "upload", resourceUrl: u.resourceUrl, kind: u.kind, previewUrl: u.previewUrl, fileName: u.fileName, mimeType: u.mimeType });
      }
    }
    if (picked.length > 0) onAdd(picked);
    onClose();
  }, [files, selected, pendingUploads, onAdd, onClose]);

  // ------------------------------------------------------------------------
  // Render helpers
  // ------------------------------------------------------------------------
  const filterButton = (k: KindFilter, label: string) => (
    <Button key={k} pressed={kind === k} onClick={() => setKind(k)} size="slim">
      {label}
    </Button>
  );

  const renderTile = (item: { id: string; kind: MediaKind; previewUrl: string; alt: string | null }) => {
    const isSelected = selected.has(item.id);
    return (
      <div
        key={item.id}
        onClick={() => toggleSelected(item.id)}
        role="button"
        aria-pressed={isSelected}
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSelected(item.id); } }}
        style={{
          position: "relative",
          width: 108,
          height: 108,
          borderRadius: 6,
          border: isSelected ? "2px solid #005bd3" : "2px solid #e1e3e5",
          overflow: "hidden",
          cursor: "pointer",
          background: "#f6f6f7",
        }}
      >
        {item.kind === "model" && !item.previewUrl ? (
          <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#616161", fontWeight: 700, fontSize: 18, letterSpacing: 0.5 }}>3D</div>
        ) : (
          <img
            src={item.previewUrl}
            alt={item.alt ?? ""}
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
        )}
        {(item.kind === "video" || item.kind === "external_video") && (
          <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="white" aria-hidden><path d="M8 5v14l11-7z" /></svg>
          </div>
        )}
        {item.kind === "model" && item.previewUrl && (
          <div style={{ position: "absolute", right: 4, bottom: 4, background: "rgba(0,0,0,0.72)", color: "#fff", font: "700 10px/1 system-ui, sans-serif", padding: "2px 5px", borderRadius: 3, pointerEvents: "none" }}>3D</div>
        )}
        {isSelected && (
          <div style={{ position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: "50%", background: "#005bd3", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
            <span style={{ color: "white", fontSize: 13, lineHeight: 1 }}>✓</span>
          </div>
        )}
      </div>
    );
  };

  const productOptions = useMemo(() => {
    const opts: Array<{ label: string; value: string }> = [
      { label: t.imageManager.browseFilesScopeOther ?? "Pick another product…", value: "other:" },
    ];
    for (const p of otherProducts) {
      opts.push({ label: p.title, value: `other:${p.id}` });
    }
    return opts;
  }, [otherProducts, t]);

  const isQueueMode = uploadCommitMode === "queue";
  const queuedSelectionCount = selected.size;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t.imageManager.browseFilesTitle ?? "Add media"}
      primaryAction={isQueueMode ? {
        content: `${t.imageManager.browseFilesAddSelected ?? "Add selected"}${queuedSelectionCount > 0 ? ` (${queuedSelectionCount})` : ""}`,
        disabled: queuedSelectionCount === 0,
        onAction: handleCommitSelected,
      } : {
        content: t.common?.close ?? "Close",
        onAction: onClose,
      }}
      secondaryActions={isQueueMode ? [{ content: t.common?.cancel ?? "Cancel", onAction: onClose }] : undefined}
    >
      <Modal.Section>
        <BlockStack gap="300">
          <TextField
            label=""
            labelHidden
            autoComplete="off"
            value={query}
            onChange={setQuery}
            placeholder={t.imageManager.browseFilesSearchPlaceholder ?? "Search by filename…"}
          />

          <ButtonGroup variant="segmented">
            {filterButton("all", t.imageManager.browseFilesFilterAll ?? "All")}
            {filterButton("image", t.imageManager.browseFilesFilterImages ?? "Images")}
            {filterButton("video", t.imageManager.browseFilesFilterVideos ?? "Videos")}
            {filterButton("model", t.imageManager.browseFilesFilterModels ?? "3D models")}
          </ButtonGroup>

          {/* Product filter — toggle + dropdown sit on one row so the modal
              header doesn't stack into a tall block on small viewports. */}
          <InlineStack gap="300" blockAlign="center" wrap>
            <Checkbox
              label={t.imageManager.browseFilesScopeCurrent ?? "Only files used in this product"}
              checked={productScope === "current"}
              disabled={!currentProductId}
              onChange={(checked) => setProductScope(checked ? "current" : "all")}
            />
            <div style={{ minWidth: 220, flex: "1 1 220px" }}>
              <Select
                label=""
                labelHidden
                value={productScope.startsWith("other:") ? productScope : "other:"}
                options={productOptions}
                onChange={(v) => {
                  if (v === "other:") return;
                  setProductScope(v);
                }}
                disabled={otherProductsLoading}
              />
            </div>
            {productScope.startsWith("other:") && (
              <Button variant="plain" onClick={() => setProductScope("all")}>
                {t.imageManager.browseFilesScopeClear ?? "Clear product filter"}
              </Button>
            )}
          </InlineStack>

          {error && <Banner tone="critical"><p>{error}</p></Banner>}

          {isLoading && files.length === 0 && pendingUploads.length === 0 ? (
            <div style={{ padding: "32px 0", display: "flex", justifyContent: "center" }}>
              <Spinner size="large" />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 8, maxHeight: 400, overflowY: "auto", padding: 4 }}>
              {pendingUploads.map(u => (
                <div key={u.uniqueId} style={{ position: "relative" }}>
                  {renderTile({ id: u.uniqueId, kind: u.kind, previewUrl: u.previewUrl, alt: u.fileName })}
                  {u.status === "uploading" && (
                    <div style={{ position: "absolute", bottom: 0, left: 0, right: 0, height: 4, background: "#e1e3e5", borderRadius: "0 0 6px 6px", overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${u.progress}%`, background: "#005bd3", transition: "width 0.3s" }} />
                    </div>
                  )}
                  {u.status === "error" && (
                    <div style={{ position: "absolute", inset: 0, background: "rgba(212,44,37,0.3)", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: 6, pointerEvents: "none" }}>
                      <Text as="span" tone="critical" variant="bodyLg">!</Text>
                    </div>
                  )}
                </div>
              ))}
              {files.length === 0 && pendingUploads.length === 0 ? (
                <div style={{ gridColumn: "1 / -1", padding: "24px 0", textAlign: "center", color: "#6d7175" }}>
                  <Text as="p" tone="subdued">
                    {t.imageManager.browseFilesEmpty ?? "No matching files in your Shopify library."}
                  </Text>
                </div>
              ) : (
                files.map(f => renderTile({ id: f.id, kind: f.kind, previewUrl: f.previewUrl, alt: f.alt }))
              )}
            </div>
          )}

          {hasNextPage && (
            <InlineStack align="center">
              <Button onClick={() => fetchFiles({ append: true })} loading={isLoading}>
                {t.common?.loadMore ?? "Load more"}
              </Button>
            </InlineStack>
          )}

          <Divider />

          {/* Upload row — central button, kept on its own line so the file
              picker affordance is unmistakable. The hidden <input> accepts
              every mime classifyFile() recognizes; the route re-validates. */}
          <InlineStack gap="200" blockAlign="center">
            <Button onClick={triggerFilePicker} variant="primary">
              {t.imageManager.uploadMediaTitle ?? "Upload images, videos, or 3D models"}
            </Button>
            <Text as="span" tone="subdued" variant="bodySm">
              JPG · PNG · WebP · MP4 · MOV · WebM · GLB
            </Text>
            <input
              ref={fileInputRef}
              type="file"
              accept={UPLOAD_ACCEPT}
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                handleFilesChosen(e.target.files);
                e.target.value = "";
              }}
            />
          </InlineStack>

          {/* External-video URL row — only shown when the parent wired
              onAddExternalUrl, which it only does for variant-targeted
              opens (product gallery has no per-variant URL slot). */}
          {onAddExternalUrl && (
            <>
              <Divider />
              <BlockStack gap="100">
                <Text as="span" variant="bodySm" tone="subdued">
                  {t.imageManager.addExternalVideoTitle ?? "Add YouTube or Vimeo URL"}
                </Text>
                <InlineStack gap="200" blockAlign="center" wrap={false}>
                  <div style={{ flex: "1 1 240px", minWidth: 200 }}>
                    <TextField
                      label=""
                      labelHidden
                      autoComplete="off"
                      value={urlInput}
                      onChange={(v) => { setUrlInput(v); if (urlError) setUrlError(null); }}
                      placeholder={t.imageManager.addExternalVideoPlaceholder ?? "https://youtube.com/watch?v=…"}
                      error={urlError ?? undefined}
                    />
                  </div>
                  <Button onClick={handleAddUrl} disabled={!urlInput.trim()}>
                    {t.imageManager.addExternalVideoButton ?? "Add link"}
                  </Button>
                </InlineStack>
              </BlockStack>
            </>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
