import { useEffect, useState, useCallback, useRef, useMemo } from "react";
import { snapshotAndPersist } from "../../utils/threeDSnapshot";
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
       *  a list.file_reference GID in variant mode, or re-uploaded via
       *  productCreateMedia with assetUrl in product mode. */
      source: "library";
      gid: string;
      kind: MediaKind;
      previewUrl: string;
      /** Full media URL (image / video / GLB), needed by product-mode
       *  callers that pass it to productCreateMedia.originalSource. */
      assetUrl: string;
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
      /** For 3D model uploads only: the permanent Shopify CDN URL of the
       *  auto-generated preview JPEG (see app/utils/threeDSnapshot.ts +
       *  /api/create-shopify-file). Persisted to custom.variant_3d_previews
       *  parallel to the model URL so the storefront can show a real
       *  thumbnail instead of the "3D" placeholder. */
      persistentPreviewUrl?: string;
    }
  | {
      /** External YouTube/Vimeo URL — variant mode persists it to the
       *  per-variant metafield; product mode hands it to
       *  productCreateMedia with mediaContentType: EXTERNAL_VIDEO. */
      source: "external_url";
      url: string;
    };

interface ApiFile {
  kind: MediaKind;
  id: string;
  previewUrl: string;
  assetUrl: string;
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
  /** Variant-gallery callers must set this. Shopify's variant_gallery is a
   *  `list.file_reference` metafield, which only accepts MediaImage | Video |
   *  GenericFile — explicitly NOT Model3d. Without this guard a picked GLB
   *  would crash the whole save (metafieldsUserError "must be a MediaImage,
   *  Video, or GenericFile"). When true: the 3D filter chip is hidden, model
   *  rows are filtered out of the library grid, and model uploads are
   *  rejected with a banner pointing the merchant at the product gallery. */
  disallowModel?: boolean;
  /** Product GID currently in focus — drives the "in this product" toggle
   *  and lets the dropdown skip itself in the "other product" list. */
  currentProductId?: string;
  /** Override the modal's heading. Defaults to a generic "Add media" string;
   *  callers typically inject "Add to [variant title]" for clarity. */
  title?: string;
}

type KindFilter = "all" | "image" | "video" | "model";

const PAGE_SIZE = 60;
/** Upper bound for the data: URL preview fallback (see handlePreviewError). */
const MAX_DATA_URL_PREVIEW_BYTES = 12 * 1024 * 1024;
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
  /** 3D-model uploads: permanent Shopify CDN URL of the auto-generated
   *  preview JPEG (forwarded from StagedItem.persistentPreviewUrl, set by
   *  BulkImageUploadPanel's snapshot pipeline). Undefined when the snapshot
   *  is still being uploaded or the file isn't a model. */
  persistentPreviewUrl?: string;
  /** External YouTube/Vimeo URL queued in the modal. When set, this row
   *  represents an external_video that needs no upload — it should be
   *  committed via onAdd with source="external_url" when the merchant
   *  hits Add. Keeps URL-add consistent with library picks + uploads
   *  (everything queues in the same selection grid). */
  externalUrl?: string;
}

export function FilePickerModal({
  open,
  onClose,
  onAdd,
  onAddExternalUrl,
  uploadCommitMode,
  initialKind = "all",
  disallowModel = false,
  currentProductId,
  title,
}: FilePickerModalProps) {
  const { t } = useI18n();

  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>(
    // A `disallowModel` caller passing initialKind="model" would otherwise
    // open the modal with an instantly-empty (and uncloseable) filter.
    disallowModel && initialKind === "model" ? "all" : initialKind
  );
  // Product filter: "all" = library-wide; any other value = the product GID
  // to scope to. Includes the current product as just another option in the
  // dropdown — no special-cased toggle.
  const [productScope, setProductScope] = useState<string>("all");
  const [productList, setProductList] = useState<ProductListItem[]>([]);
  const [productListLoading, setProductListLoading] = useState(false);

  const [files, setFiles] = useState<ApiFile[]>([]);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);

  const [urlInput, setUrlInput] = useState("");
  const [urlError, setUrlError] = useState<string | null>(null);

  // Tiles whose <img> failed to load. Two independent sources feed it, and
  // both used to render the browser's broken-link icon:
  //   • a library file Shopify is still processing — /api/files reports
  //     previewUrl: "" for a MediaImage whose `image` is null, and
  //     <img src=""> resolves to the document URL and fails;
  //   • a local upload whose blob: URL the browser refuses to render.
  // Either way the merchant gets a labelled placeholder instead, and for the
  // upload case we re-derive the preview from the File as a data: URL.
  const [brokenPreviews, setBrokenPreviews] = useState<Set<string>>(new Set());
  // uniqueId → the File behind a pending upload, so a failed blob: preview
  // can be regenerated. Kept in a ref (not in state) because it is only ever
  // read from an event handler and would otherwise re-render every tile.
  const pendingFilesRef = useRef<Map<string, File>>(new Map());
  // uniqueId → the preview URL currently in effect for that upload. The
  // "immediate" commit path fires from an XHR callback that closed over the
  // item as it was CREATED, so without this it would hand the parent the
  // original blob: URL even after the data:-URL fallback replaced it — and
  // the optimistic gallery tile would be broken for the same reason the modal
  // tile was.
  const pendingPreviewRef = useRef<Map<string, string>>(new Map());

  const fileInputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset on (re-)open so a stale selection / uploads from a previous open
  // cannot accidentally be re-committed.
  useEffect(() => {
    if (open) {
      setQuery("");
      setKind(disallowModel && initialKind === "model" ? "all" : initialKind);
      setProductScope("all");
      setProductList([]);
      setSelected(new Set());
      setError(null);
      setEndCursor(null);
      setHasNextPage(false);
      setFiles([]);
      setPendingUploads([]);
      setBrokenPreviews(new Set());
      pendingFilesRef.current = new Map();
      pendingPreviewRef.current = new Map();
      setUrlInput("");
      setUrlError(null);
    }
  }, [open, initialKind, disallowModel]);

  // ------------------------------------------------------------------------
  // File-list fetching
  // ------------------------------------------------------------------------
  const usedByProductId = useMemo(() => {
    return productScope === "all" ? null : productScope;
  }, [productScope]);

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
  // Product dropdown population. Loaded once when the modal opens; the list
  // includes the current product as just another row so the merchant can
  // pick it like any other (matching the user's "default = all products,
  // dropdown lists everything" spec).
  // ------------------------------------------------------------------------
  const loadProducts = useCallback(async () => {
    setProductListLoading(true);
    try {
      const res = await fetch(`/api/products-list?first=200`);
      const data = await res.json();
      setProductList(data.products ?? []);
    } catch {
      // Silent: dropdown falls back to ["All products"] only.
    } finally {
      setProductListLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) loadProducts();
  }, [open, loadProducts]);

  // ------------------------------------------------------------------------
  // Upload pipeline (mirrors BulkImageUploadPanel's flow, inlined here so the
  // modal can drive its own progress UI and commit-on-complete behaviour).
  // ------------------------------------------------------------------------
  const handleFilesChosen = useCallback(async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const classified = Array.from(fileList)
      .map(f => ({ file: f, kind: classifyFile(f.type, f.name) }))
      .filter(x => x.kind !== null);
    // Variant-gallery context: drop GLBs before they ever hit
    // stagedUploadsCreate, and surface a clear banner so the merchant knows
    // to use the product gallery instead.
    let accepted = classified.map(x => x.file);
    if (disallowModel) {
      const models = classified.filter(x => x.kind === "model");
      accepted = classified.filter(x => x.kind !== "model").map(x => x.file);
      if (models.length > 0) {
        setError(t.imageManager.browseFilesNoModelsInVariant ?? "3D models can only be added to the product gallery, not to a variant.");
      }
    }
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

    for (let i = 0; i < newItems.length; i++) {
      pendingFilesRef.current.set(newItems[i].uniqueId, accepted[i]);
      pendingPreviewRef.current.set(newItems[i].uniqueId, newItems[i].previewUrl);
    }
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
        const { url, resourceUrl, parameters, httpMethod, error: stagedErr } = stagedJson;
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
              // extra click. For 3D models we additionally wait for the
              // snapshot+persist pipeline so the storefront gets a real
              // preview URL on first save — without the await, onAdd would
              // fire with persistentPreviewUrl=undefined and the snapshot
              // would only land on a later save (or not at all, since the
              // pending state was already consumed by handleModalAdd).
              if (uploadCommitMode === "immediate") {
                const finalize = async (persistentPreviewUrl?: string) => {
                  onAdd([{
                    source: "upload",
                    resourceUrl,
                    kind: item.kind,
                    previewUrl: pendingPreviewRef.current.get(item.uniqueId) ?? item.previewUrl,
                    fileName: item.fileName,
                    mimeType: item.mimeType,
                    persistentPreviewUrl,
                  }]);
                  pendingFilesRef.current.delete(item.uniqueId);
                  pendingPreviewRef.current.delete(item.uniqueId);
                  setPendingUploads(prev => prev.filter(p => p.uniqueId !== item.uniqueId));
                };
                if (item.kind === "model") {
                  // Snapshot+persist is awaited but its failure must NOT
                  // block onAdd — the .glb is uploaded and the merchant
                  // should still see the tile. Storefront falls back to
                  // its "3D" placeholder for this slot.
                  snapshotAndPersist(file)
                    .then(({ blobUrl, cdnUrl }) => {
                      setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId
                        ? { ...it, previewUrl: blobUrl, persistentPreviewUrl: cdnUrl }
                        : it));
                      return finalize(cdnUrl);
                    })
                    .catch((err) => {
                      console.warn("[FilePickerModal] 3D snapshot/persist failed", { file: file.name, err });
                      return finalize(undefined);
                    });
                } else {
                  void finalize();
                }
              }
              // Queue mode + 3D model: no client-side snapshot. The pipeline
              // (model-viewer + canvas.toBlob) timed out on big .glb files
              // and forced the merchant to wait ~20s before "Add selected"
              // became active, with no upside — server-side Shopify
              // Model3d.preview generation runs on save anyway and handles
              // arbitrarily large files without occupying the merchant's
              // browser tab.
              resolve();
            } else {
              console.error("[FilePickerModal XHR upload FAILED]", {
                fileName: file.name,
                xhrStatus: xhr.status,
                statusText: xhr.statusText,
                response: xhr.responseText.slice(0, 500),
              });
              setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
              reject(new Error(`Upload failed: HTTP ${xhr.status}`));
            }
          };
          xhr.onerror = () => {
            console.error("[FilePickerModal XHR network error]", { fileName: file.name });
            setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
            reject(new Error("Upload network error"));
          };
          // Shopify's staged target is reached differently per resource:
          //   IMAGE: signed PUT — body is the raw file, Content-Type header
          //   VIDEO / MODEL_3D: signed POST policy — multipart/form-data with
          //     every `parameters` entry as a form field FIRST, then `file`
          //     LAST (the underlying storage requires this order). Skipping
          //     this branch (always PUT) was the previous bug: PUTting a
          //     `.glb` to a POST-only target returned 405 and the upload
          //     silently failed, leaving the merchant clicking Add with
          //     nothing happening.
          if (httpMethod === "POST") {
            const form = new FormData();
            for (const p of (parameters ?? []) as Array<{ name: string; value: string }>) {
              form.append(p.name, p.value);
            }
            form.append("file", file);
            xhr.open("POST", url);
            xhr.send(form);
          } else {
            xhr.open("PUT", url);
            xhr.setRequestHeader("Content-Type", file.type);
            xhr.send(file);
          }
        });
      } catch {
        setPendingUploads(prev => prev.map(it => it.uniqueId === item.uniqueId ? { ...it, status: "error" as const } : it));
      }
    }));
  }, [uploadCommitMode, onAdd, t, disallowModel]);

  /** An <img> in the grid failed to load. Mark the tile so it renders a
   *  labelled placeholder instead of the browser's broken-link icon, and —
   *  when the tile is a local upload we still hold the File for — re-derive
   *  the preview as a data: URL. A blob: URL that the browser will not render
   *  is the only way a freshly picked image can fail here, and a data: URL
   *  does not depend on the object-URL store at all. */
  const handlePreviewError = useCallback((id: string) => {
    setBrokenPreviews(prev => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    const file = pendingFilesRef.current.get(id);
    if (!file) return;
    // Images only. A video's blob: URL can NEVER render inside the tile's
    // <img>, so onError always fires for one — base64-encoding every video
    // under the size cap would burn memory (and push the string on into
    // pendingProductNewMedia and the settling entry) for a preview that
    // still cannot display. The placeholder is the right answer there.
    if (classifyFile(file.type, file.name) !== "image") return;
    // Retry exactly once. Without the data:-guard a data: URL that also fails
    // to decode would loop: the fallback clears the broken flag, the <img>
    // renders again, errors again, and we are back here.
    if (pendingPreviewRef.current.get(id)?.startsWith("data:")) return;
    // Cap the fallback: base64 inflates by ~33% and a large file would
    // freeze the tab for a thumbnail.
    if (file.size > MAX_DATA_URL_PREVIEW_BYTES) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      if (!dataUrl) return;
      pendingPreviewRef.current.set(id, dataUrl);
      setPendingUploads(cur => cur.map(u => (u.uniqueId === id ? { ...u, previewUrl: dataUrl } : u)));
      setBrokenPreviews(cur => {
        if (!cur.has(id)) return cur;
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    };
    reader.readAsDataURL(file);
  }, []);

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
    // Queue the URL as a pending row in the modal grid (same selection model
    // as uploads + library picks) instead of committing immediately. Before
    // this, external URLs were the only add-flow that bypassed the modal's
    // Add-selected button — every other source queued, hit-Add-once was
    // already muscle memory, so the URL row felt unexpectedly destructive.
    setPendingUploads(prev => {
      if (prev.some(u => u.externalUrl === parsed.canonicalUrl)) return prev;
      const uniqueId = crypto.randomUUID();
      setSelected(s => { const n = new Set(s); n.add(uniqueId); return n; });
      return [
        ...prev,
        {
          uniqueId,
          fileName: parsed.canonicalUrl,
          mimeType: "",
          kind: "external_video" as MediaKind,
          previewUrl: parsed.thumbnailUrl ?? "",
          resourceUrl: parsed.canonicalUrl,
          progress: 100,
          status: "ready" as const,
          externalUrl: parsed.canonicalUrl,
        },
      ];
    });
    setUrlInput("");
    setUrlError(null);
    // Intentionally don't close — merchants often add several links in a row.
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
        picked.push({ source: "library", gid: f.reference, kind: f.kind, previewUrl: f.previewUrl, assetUrl: f.assetUrl, alt: f.alt });
      }
    }
    for (const u of pendingUploads) {
      if (!selected.has(u.uniqueId)) continue;
      // Queued external URL — emit via the external_url source so the parent
      // routes it through onAddExternalUrl (variant: per-variant metafield;
      // product: productCreateMedia EXTERNAL_VIDEO).
      if (u.externalUrl) {
        picked.push({ source: "external_url", url: u.externalUrl });
        continue;
      }
      if (u.status === "ready" && u.resourceUrl) {
        picked.push({
          source: "upload",
          resourceUrl: u.resourceUrl,
          kind: u.kind,
          previewUrl: u.previewUrl,
          fileName: u.fileName,
          mimeType: u.mimeType,
          // 3D model uploads carry a permanent CDN URL of their generated
          // preview JPEG (see BulkImageUploadPanel snapshot pipeline). Forward
          // it so the parent's handleModalAdd can persist it to
          // variant_3d_previews. Undefined for non-models / when the snapshot
          // never completed — handler treats both as "no preview".
          persistentPreviewUrl: u.persistentPreviewUrl,
        });
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
    const showPlaceholder = !item.previewUrl || brokenPreviews.has(item.id);
    const placeholderLabel = item.kind === "model"
      ? "3D"
      : item.kind === "video" || item.kind === "external_video"
        ? (t.imageManager.videoLabel ?? "Video")
        : (t.imageManager.previewUnavailable ?? "Image");
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
        {showPlaceholder ? (
          // Never render <img> without a usable src: an empty string resolves
          // to the document URL and paints the browser's broken-link icon,
          // which is what a still-processing library file and a rejected
          // blob: URL both looked like.
          <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", gap: 2, alignItems: "center", justifyContent: "center", padding: 4, textAlign: "center", color: "#616161", fontWeight: 700, fontSize: 14, letterSpacing: 0.5 }}>
            <span>{placeholderLabel}</span>
            {item.alt ? (
              <span style={{ fontWeight: 400, fontSize: 9, lineHeight: "11px", color: "#8a8a8a", overflow: "hidden", wordBreak: "break-all", maxHeight: 22 }}>
                {item.alt}
              </span>
            ) : null}
          </div>
        ) : (
          <img
            src={item.previewUrl}
            alt={item.alt ?? ""}
            onError={() => handlePreviewError(item.id)}
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
    // Default option keeps the picker library-wide; everything else is a
    // single product (current one included, sorted naturally by title from
    // the API). Putting it all in one Select avoids the two-control layout
    // that turned out to confuse the merchant in the previous iteration.
    const opts: Array<{ label: string; value: string }> = [
      { label: t.imageManager.browseFilesScopeAll ?? "All products", value: "all" },
    ];
    for (const p of productList) {
      opts.push({ label: p.title, value: p.id });
    }
    return opts;
  }, [productList, t]);

  const queuedSelectionCount = selected.size;
  // Selected uploads that haven't reached "ready" yet — used to gate the
  // primary Add button so the merchant can't commit while an upload is mid-
  // flight (handleCommitSelected would otherwise silently filter them out and
  // their content would be lost without any feedback).
  const selectedUploadingCount = pendingUploads.filter(
    u => selected.has(u.uniqueId) && u.status === "uploading"
  ).length;
  const selectedErrorCount = pendingUploads.filter(
    u => selected.has(u.uniqueId) && u.status === "error"
  ).length;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? t.imageManager.browseFilesTitle ?? "Add media"}
      // Add button is always primary so library picks always have a clear
      // commit affordance, in both queue and immediate modes. In immediate
      // mode uploads commit on-the-fly (without contributing to the count)
      // — only library picks accumulate in the selection.
      primaryAction={{
        // Show "Uploading…" while any selected upload is still in flight, so
        // the merchant gets explicit visual feedback that the button is
        // intentionally inactive (not broken). The spinner state also blocks
        // the click, which is the real fix for the "I clicked Add but nothing
        // happened" report: previously the click ran handleCommitSelected,
        // which filtered out non-ready uploads, leaving picked=[] and the
        // user's content silently lost.
        content: selectedUploadingCount > 0
          ? "Uploading…"
          : `${t.imageManager.browseFilesAddSelected ?? "Add selected"}${queuedSelectionCount > 0 ? ` (${queuedSelectionCount})` : ""}`,
        disabled: queuedSelectionCount === 0 || selectedUploadingCount > 0,
        loading: selectedUploadingCount > 0,
        onAction: handleCommitSelected,
      }}
      secondaryActions={[{ content: t.common?.close ?? "Close", onAction: onClose }]}
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
            {!disallowModel && filterButton("model", t.imageManager.browseFilesFilterModels ?? "3D models")}
          </ButtonGroup>

          {/* Product filter — one dropdown, default "All products", every
              product (including the currently focused one) is just another
              entry so the merchant doesn't have to learn a separate concept
              for "this" vs "other". */}
          <Select
            label=""
            labelHidden
            value={productScope}
            options={productOptions}
            onChange={setProductScope}
            disabled={productListLoading && productList.length === 0}
          />

          {error && <Banner tone="critical"><p>{error}</p></Banner>}

          {isLoading && files.length === 0 && pendingUploads.length === 0 ? (
            <div style={{ padding: "32px 0", display: "flex", justifyContent: "center" }}>
              <Spinner size="large" />
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 8, maxHeight: "clamp(160px, calc(100vh - 520px), 400px)", overflowY: "auto", padding: 4 }}>
              {pendingUploads.map(u => (
                // Constrain the wrapper to the tile's 108px so the absolutely
                // positioned progress + error overlays line up. Without this
                // the grid cell stretches to its 1fr column width and the
                // overlays (left:0/right:0) end up wider than the tile.
                <div key={u.uniqueId} style={{ position: "relative", width: 108 }}>
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
              {(() => {
                // Variant-gallery callers strip Model3d here as the final
                // belt-and-braces guard — the server still rejects them, but
                // the merchant should never even see a pickable 3D tile in a
                // variant picker. The kind=image|video|all server filter
                // already covers most rows; this catches the "All" branch.
                const visible = disallowModel ? files.filter(f => f.kind !== "model") : files;
                if (visible.length === 0 && pendingUploads.length === 0) {
                  return (
                    <div style={{ gridColumn: "1 / -1", padding: "24px 0", textAlign: "center", color: "#6d7175" }}>
                      <Text as="p" tone="subdued">
                        {t.imageManager.browseFilesEmpty ?? "No matching files in your Shopify library."}
                      </Text>
                    </div>
                  );
                }
                return visible.map(f => renderTile({ id: f.id, kind: f.kind, previewUrl: f.previewUrl, alt: f.alt }));
              })()}
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

          {/* External-video URL row — sits ABOVE the upload button per the
              merchant's spec ("alles an einem Ort"). Rendered in both
              product and variant modes; the parent's onAddExternalUrl
              handler routes it to either the per-variant metafield or to
              product.media via productCreateMedia EXTERNAL_VIDEO. */}
          {onAddExternalUrl && (
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
          )}

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
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
