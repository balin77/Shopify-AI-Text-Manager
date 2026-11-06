/**
 * Reads a request body with a hard byte cap, for routes any storefront visitor
 * can reach (the app proxy endpoints). Shared by proxy.direct-add and
 * proxy.collect-strings so both bound what an anonymous caller can make the
 * server buffer.
 */

export type CappedBody = { ok: true; text: string } | { ok: false; tooLarge: boolean };

/**
 * True when the request DECLARES a body larger than `maxBytes`. Callers refuse
 * such a request before doing any other work; `readBodyCapped` still enforces
 * the cap for a missing or lying Content-Length.
 */
export function declaresBodyLargerThan(request: Request, maxBytes: number): boolean {
  const declaredLength = Number(request.headers.get("content-length"));
  return Number.isFinite(declaredLength) && declaredLength > maxBytes;
}

/**
 * Reads the body as text and gives up as soon as it passes `maxBytes`, so a
 * missing or lying Content-Length cannot make the server buffer more than the
 * cap.
 *
 * On overflow the reader is RELEASED, never cancelled: in production the body
 * is @react-router/node's `createReadableStreamFromReadable(req)`, whose
 * `cancel` destroys the IncomingMessage socket — the 413 would then never reach
 * the client (ECONNRESET) and the response write could log write-after-destroy.
 * Releasing just stops reading; the caller answers with `Connection: close`
 * so Node does not try to keep the half-read connection alive.
 */
export async function readBodyCapped(request: Request, maxBytes: number): Promise<CappedBody> {
  if (!request.body) return { ok: true, text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          reader.releaseLock();
        } catch {
          // Nothing to do: we only stop reading.
        }
        return { ok: false, tooLarge: true };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, tooLarge: false };
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    buf.set(c, offset);
    offset += c.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(buf) };
}
