/**
 * The smallest possible writer of React Router's single-fetch wire format
 * (turbo-stream v2) for plain JSON values.
 *
 * Why it exists: when our own rate limiter refuses a `.data` request and the
 * retries have run out, the router must still get an ANSWER it understands.
 * A bare 429 makes it throw (`res.status >= 400 && !X-Remix-Response`), and a
 * thrown fetcher/navigation error replaces the whole page with the route's
 * ErrorBoundary. A response that carries `X-Remix-Response` and a decodable
 * body is an ordinary result instead: a fetcher gets its `data`, nothing is
 * thrown, the page stays and its unsaved input with it.
 *
 * The router ships only the DECODER on the client, so this writes the format
 * by hand. It is exercised against the router's own decoder (tests), never
 * trusted on its own.
 *
 * Format: a JSON array of "slots"; slot 0 is the root. An object slot maps
 * `"_<keySlot>": <valueSlot>`, an array slot lists value slots, a string /
 * finite number / boolean slot holds its JSON text. Negative numbers are the
 * reserved constants for null, undefined, NaN and the infinities.
 */
const NULL = -5;
const UNDEFINED = -7;
const NAN = -2;
const POSITIVE_INFINITY = -6;
const NEGATIVE_INFINITY = -3;
const NEGATIVE_ZERO = -4;

export function encodeTurboStreamValue(root: unknown): string {
  const slots: string[] = [];
  const flatten = (value: unknown): number => {
    if (value === undefined) return UNDEFINED;
    if (value === null) return NULL;
    if (typeof value === "number") {
      if (Number.isNaN(value)) return NAN;
      if (value === Number.POSITIVE_INFINITY) return POSITIVE_INFINITY;
      if (value === Number.NEGATIVE_INFINITY) return NEGATIVE_INFINITY;
      if (value === 0 && 1 / value < 0) return NEGATIVE_ZERO;
    }
    const index = slots.length;
    slots.push(""); // reserved before the children take their slots
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      slots[index] = JSON.stringify(value);
    } else if (Array.isArray(value)) {
      slots[index] = `[${value.map((item) => flatten(item)).join(",")}]`;
    } else if (typeof value === "object") {
      const record = value as Record<string, unknown>;
      slots[index] = `{${Object.keys(record)
        .map((key) => `"_${flatten(key)}":${flatten(record[key])}`)
        .join(",")}}`;
    } else {
      throw new Error("Cannot encode a function or symbol");
    }
    return index;
  };
  const id = flatten(root);
  return id < 0 ? `${id}\n` : `[${slots.join(",")}]\n`;
}
