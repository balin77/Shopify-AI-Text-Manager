import type { ImageMeta } from "./types";

/**
 * A small picture of the ONE selected image, shown next to the bar's alt editor: the bar can act on
 * a tile inside a folded gallery, and this is how the merchant sees which image it is.
 * (`app-touch-exempt-img` keeps the inline size under the phone's img rules.)
 */
export function SelectedThumb({ url, meta }: { url: string; meta?: ImageMeta }) {
  const src = meta?.kind && meta.kind !== "image" ? meta.previewUrl : url;
  if (!src) return null;
  return (
    <img
      className="app-touch-exempt-img"
      data-im-selected-thumb
      src={src}
      alt=""
      draggable={false}
      style={{ width: 40, height: 40, objectFit: "cover", borderRadius: 4, flexShrink: 0, border: "1px solid var(--app-surface-border-color)" }}
    />
  );
}
