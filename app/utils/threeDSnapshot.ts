/**
 * Client-side .glb thumbnail generation. Spawns an off-screen
 * <model-viewer> with the file's blob URL, waits for the first frame,
 * snapshots the WebGL canvas via `toBlob()`, returns a JPEG Blob.
 *
 * Used by the variant image manager when a 3D model is uploaded — the
 * resulting blob is uploaded as a sibling image asset so we have a real
 * preview to show in the admin grid AND to ship to the storefront via
 * the parallel `custom.variant_3d_previews` metafield. No server-side
 * rendering / headless browser needed.
 *
 * model-viewer.min.js is a copy of the one shipped with the variant-
 * gallery extension (single source of truth — see scripts/build steps
 * or copy manually after upgrading). Loaded once per session and
 * cached on window so subsequent calls reuse the import.
 */

const MODEL_VIEWER_SCRIPT_URL = "/model-viewer.min.js";

let modelViewerLoadPromise: Promise<void> | null = null;

/** Idempotently load Google's <model-viewer> custom element. */
export function loadModelViewerLib(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("loadModelViewerLib must run in the browser"));
  }
  if (customElements.get("model-viewer")) return Promise.resolve();
  if (modelViewerLoadPromise) return modelViewerLoadPromise;
  modelViewerLoadPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector(
      `script[data-cp-model-viewer="1"]`,
    ) as HTMLScriptElement | null;
    // Wait until the custom element is actually defined, not just until the
    // module script fires onload. type="module" scripts can fire onload
    // before the module body has executed (export resolution is async), so
    // resolving on script.onload was racing the registration — we created
    // a <model-viewer> element before the class was registered, the browser
    // treated it as HTMLUnknownElement, and the "load" event we awaited in
    // snapshotFromGlbFile never fired → 20s timeout → "no preview generated".
    const waitForCustomElement = () => {
      const timer = window.setTimeout(() => {
        modelViewerLoadPromise = null;
        reject(new Error("model-viewer custom element never registered"));
      }, 15000);
      customElements
        .whenDefined("model-viewer")
        .then(() => {
          window.clearTimeout(timer);
          resolve();
        })
        .catch((err) => {
          window.clearTimeout(timer);
          modelViewerLoadPromise = null;
          reject(err);
        });
    };
    const s = existing ?? document.createElement("script");
    s.type = "module";
    s.dataset.cpModelViewer = "1";
    s.onerror = () => {
      modelViewerLoadPromise = null;
      reject(new Error("Failed to load model-viewer library"));
    };
    if (!existing) {
      s.src = MODEL_VIEWER_SCRIPT_URL;
      document.head.appendChild(s);
    }
    waitForCustomElement();
  });
  return modelViewerLoadPromise;
}

export interface SnapshotOptions {
  /** Square output edge in pixels. Default 512 — large enough for retina
   *  thumbs in the admin and decent quality on the storefront. */
  size?: number;
  /** JPEG quality 0..1. Default 0.85 — visually lossless for thumbs at
   *  a fraction of the byte size of PNG. */
  quality?: number;
  /** Abort if model-viewer cannot render within this many ms.
   *  Default 20000 — generous for big .glb files. */
  timeoutMs?: number;
}

/**
 * Generate a JPEG thumbnail Blob from a .glb File (or any URL that
 * <model-viewer> can load). Resolves once the GL canvas has painted at
 * least one frame. Off-screen DOM is removed before resolve.
 */
export async function snapshotFromGlbFile(
  file: File | Blob,
  opts: SnapshotOptions = {},
): Promise<Blob> {
  const size = opts.size ?? 512;
  const quality = opts.quality ?? 0.85;
  const timeoutMs = opts.timeoutMs ?? 20000;

  await loadModelViewerLib();

  const objectUrl = URL.createObjectURL(file);
  // Off-screen but in-layout — model-viewer needs a non-zero box to size
  // its GL canvas. Absolute + far off-screen + non-zero size + pointer-
  // events:none keeps it invisible and uninteractive while still
  // triggering paint.
  const host = document.createElement("div");
  host.setAttribute(
    "style",
    `position: fixed; left: -10000px; top: 0; width: ${size}px; height: ${size}px; pointer-events: none; opacity: 0;`,
  );
  const mv = document.createElement("model-viewer") as any;
  mv.setAttribute("src", objectUrl);
  mv.setAttribute("camera-controls", "");
  mv.setAttribute("interaction-prompt", "none");
  mv.setAttribute(
    "style",
    `width: ${size}px; height: ${size}px; background: transparent;`,
  );
  host.appendChild(mv);
  document.body.appendChild(host);

  const cleanup = () => {
    try {
      host.remove();
    } catch {
      // noop
    }
    URL.revokeObjectURL(objectUrl);
  };

  try {
    const blob = await new Promise<Blob>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("3D snapshot timeout"));
      }, timeoutMs);

      const onError = (e: any) => {
        window.clearTimeout(timer);
        reject(new Error(`model-viewer error: ${e?.detail?.sourceError?.message ?? "load failed"}`));
      };

      const onLoad = async () => {
        try {
          // Two RAFs to let model-viewer commit its first painted frame
          // before we read the canvas — without this, `toBlob` can come
          // back transparent on the very first call.
          await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
          const out: Blob = await mv.toBlob({
            mimeType: "image/jpeg",
            qualityArgument: quality,
            idealAspect: true,
          });
          window.clearTimeout(timer);
          if (!out || out.size === 0) {
            reject(new Error("3D snapshot empty"));
            return;
          }
          resolve(out);
        } catch (err: any) {
          window.clearTimeout(timer);
          reject(new Error(`toBlob failed: ${err?.message ?? err}`));
        }
      };

      mv.addEventListener("load", onLoad, { once: true });
      mv.addEventListener("error", onError, { once: true });
    });
    return blob;
  } finally {
    cleanup();
  }
}

/**
 * Generate a snapshot of `file` AND upload it to Shopify Files via the
 * staged-upload → fileCreate pipeline, returning the permanent CDN URL.
 * Used at .glb upload time so the storefront's <model-viewer> poster and
 * the variant thumbnail can both render a real image without depending on
 * the merchant's session or the client running model-viewer at view-time.
 *
 * Failure modes (re-thrown so callers can decide whether to surface):
 *   • snapshotFromGlbFile rejects (timeout / corrupt GLB / WebGL absent)
 *   • staged-upload route returns non-ok / no resourceUrl
 *   • PUT to the staging URL returns non-2xx
 *   • create-shopify-file route fails (Shopify rejected the file or the
 *     fileStatus poll exceeded its budget — caller should treat the
 *     latter as transient and retry on the next save).
 */
export async function snapshotAndPersist(
  file: File,
  opts: { previewFileName?: string } = {},
): Promise<{ blobUrl: string; cdnUrl: string }> {
  const blob = await snapshotFromGlbFile(file);
  const blobUrl = URL.createObjectURL(blob);
  const previewFileName =
    opts.previewFileName ?? file.name.replace(/\.glb$/i, "") + "-preview.jpg";

  const stagedRes = await fetch("/api/staged-upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      filename: previewFileName,
      mimeType: "image/jpeg",
      fileSize: blob.size,
    }),
  });
  const stagedJson = await stagedRes.json();
  if (!stagedRes.ok || !stagedJson.url || !stagedJson.resourceUrl) {
    throw new Error(stagedJson.error || `staged-upload HTTP ${stagedRes.status}`);
  }

  // The IMAGE resource is a signed-PUT GCS target — no multipart parameters.
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", stagedJson.url);
    xhr.setRequestHeader("Content-Type", "image/jpeg");
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`preview PUT HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error("preview PUT network error"));
    xhr.send(blob);
  });

  const createRes = await fetch("/api/create-shopify-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      resourceUrl: stagedJson.resourceUrl,
      alt: previewFileName,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.url) {
    throw new Error(createJson.error || `create-shopify-file HTTP ${createRes.status}`);
  }
  return { blobUrl, cdnUrl: createJson.url };
}
