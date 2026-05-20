import { useEffect, useState, useCallback, useRef } from "react";
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
} from "@shopify/polaris";
import { useI18n } from "../../contexts/I18nContext";
import type { MediaKind } from "./types";

export interface PickedFile {
  /** Shopify File GID (MediaImage / Video / Model3d / GenericFile). */
  gid: string;
  kind: MediaKind;
  /** Best-effort thumbnail URL. Empty for previewless GLB / generic files. */
  previewUrl: string;
  alt: string | null;
}

interface ApiFile {
  kind: MediaKind;
  id: string;
  previewUrl: string;
  reference: string;
  alt: string | null;
}

interface FilePickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Called with the merchant's selection when they hit "Add selected". The
   *  modal closes itself afterwards. */
  onAdd: (files: PickedFile[]) => void;
  /** Optional starting filter — useful when the picker is triggered from a
   *  context that already knows the relevant media type ("attach video to
   *  variant X"). */
  initialKind?: "all" | "image" | "video" | "model";
}

type KindFilter = "all" | "image" | "video" | "model";

const PAGE_SIZE = 60;

export function FilePickerModal({ open, onClose, onAdd, initialKind = "all" }: FilePickerModalProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<KindFilter>(initialKind);
  const [files, setFiles] = useState<ApiFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [endCursor, setEndCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);

  // Reset state every time the modal opens — a stale selection from a
  // previous open would let merchants accidentally add the wrong files.
  useEffect(() => {
    if (open) {
      setQuery("");
      setKind(initialKind);
      setSelected(new Set());
      setError(null);
      setEndCursor(null);
      setHasNextPage(false);
      setFiles([]);
    }
  }, [open, initialKind]);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchFiles = useCallback(async (opts: { append: boolean }) => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (query.trim()) params.set("q", query.trim());
      if (kind !== "all") params.set("kind", kind);
      params.set("first", String(PAGE_SIZE));
      if (opts.append && endCursor) params.set("after", endCursor);
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
  }, [query, kind, endCursor]);

  // Debounce search input + refetch on filter change. Closing the modal
  // cancels the in-flight debounce so a late response can't repopulate
  // after onClose.
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setEndCursor(null);
      fetchFiles({ append: false });
    }, 250);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // fetchFiles is intentionally excluded — its endCursor dep would cause a
    // refetch loop after every page-2 load. We only want query / kind / open
    // to trigger a fresh fetch here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, query, kind]);

  const toggleSelected = useCallback((id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleAdd = useCallback(() => {
    const picked: PickedFile[] = files
      .filter(f => selected.has(f.id))
      .map(f => ({ gid: f.reference, kind: f.kind, previewUrl: f.previewUrl, alt: f.alt }));
    if (picked.length > 0) onAdd(picked);
    onClose();
  }, [files, selected, onAdd, onClose]);

  const filterButton = (k: KindFilter, label: string) => (
    <Button key={k} pressed={kind === k} onClick={() => setKind(k)} size="slim">
      {label}
    </Button>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t.imageManager.browseFilesTitle ?? "Browse media library"}
      primaryAction={{
        content: `${t.imageManager.browseFilesAddSelected ?? "Add selected"}${selected.size > 0 ? ` (${selected.size})` : ""}`,
        disabled: selected.size === 0,
        onAction: handleAdd,
      }}
      secondaryActions={[{ content: t.common?.cancel ?? "Cancel", onAction: onClose }]}
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

          {error && <Banner tone="critical"><p>{error}</p></Banner>}

          {isLoading && files.length === 0 ? (
            <div style={{ padding: "32px 0", display: "flex", justifyContent: "center" }}>
              <Spinner size="large" />
            </div>
          ) : files.length === 0 ? (
            <div style={{ padding: "24px 0", textAlign: "center", color: "#6d7175" }}>
              <Text as="p" tone="subdued">
                {t.imageManager.browseFilesEmpty ?? "No matching files in your Shopify library."}
              </Text>
            </div>
          ) : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(108px, 1fr))", gap: 8, maxHeight: 480, overflowY: "auto", padding: 4 }}>
              {files.map(f => {
                const isSelected = selected.has(f.id);
                return (
                  <div
                    key={f.id}
                    onClick={() => toggleSelected(f.id)}
                    role="button"
                    aria-pressed={isSelected}
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSelected(f.id); } }}
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
                    {f.kind === "model" && !f.previewUrl ? (
                      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "#616161", fontWeight: 700, fontSize: 18, letterSpacing: 0.5 }}>
                        3D
                      </div>
                    ) : (
                      <img
                        src={f.previewUrl}
                        alt={f.alt ?? ""}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    )}
                    {(f.kind === "video" || f.kind === "external_video") && (
                      <div style={{ position: "absolute", inset: 0, background: "rgba(0,0,0,0.32)", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                        <svg width="28" height="28" viewBox="0 0 24 24" fill="white" aria-hidden><path d="M8 5v14l11-7z" /></svg>
                      </div>
                    )}
                    {f.kind === "model" && f.previewUrl && (
                      <div style={{ position: "absolute", right: 4, bottom: 4, background: "rgba(0,0,0,0.72)", color: "#fff", font: "700 10px/1 system-ui, sans-serif", padding: "2px 5px", borderRadius: 3, pointerEvents: "none" }}>
                        3D
                      </div>
                    )}
                    {isSelected && (
                      <div style={{ position: "absolute", top: 4, right: 4, width: 20, height: 20, borderRadius: "50%", background: "#005bd3", display: "flex", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
                        <span style={{ color: "white", fontSize: 13, lineHeight: 1 }}>✓</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {hasNextPage && (
            <InlineStack align="center">
              <Button onClick={() => fetchFiles({ append: true })} loading={isLoading}>
                {t.common?.loadMore ?? "Load more"}
              </Button>
            </InlineStack>
          )}
        </BlockStack>
      </Modal.Section>
    </Modal>
  );
}
