/**
 * The browser half of a Shopify staged upload, in one place.
 *
 * `/api/staged-upload` hands back a signed target; the file then goes to it
 * straight from the browser. Four call sites used to carry their own XHR, two
 * of them with `xhr.onload = () => resolve()` -- which resolves on ANY status,
 * so a refused upload (403 from an expired policy, 405 from the wrong verb)
 * was added to the gallery as if it had worked and failed later, on save,
 * with nothing pointing back at the file.
 *
 * Shopify reaches the target differently per resource: IMAGE is a signed PUT
 * (raw body, Content-Type header); VIDEO / MODEL_3D are a signed POST policy
 * -- multipart/form-data with every `parameters` entry as a field FIRST and
 * `file` LAST (the storage requires that order). PUTting a `.glb` to a
 * POST-only target answers 405.
 */

export interface StagedUploadTarget {
  url: string;
  httpMethod?: string | null;
  parameters?: Array<{ name: string; value: string }> | null;
}

/** Rejects with the HTTP status in the message on a non-2xx answer, and on a network error, abort or timeout. */
export function uploadToStagedTarget(
  target: StagedUploadTarget,
  file: Blob,
  onProgress?: (percent: number) => void,
  filename?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    if (onProgress) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
    }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`Upload failed: HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload network error"));
    xhr.onabort = () => reject(new Error("Upload aborted"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    if (target.httpMethod === "POST") {
      const form = new FormData();
      for (const p of target.parameters ?? []) form.append(p.name, p.value);
      if (filename) form.append("file", file, filename);
      else form.append("file", file);
      xhr.open("POST", target.url);
      xhr.send(form);
    } else {
      xhr.open("PUT", target.url);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.send(file);
    }
  });
}
