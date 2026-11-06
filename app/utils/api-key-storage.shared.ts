/**
 * The merchant's own AI provider keys are WRITE-ONLY from the browser's point
 * of view.
 *
 * The Settings loader used to decrypt all six stored keys and ship them in
 * plaintext in its payload, so anything that could read the page (an XSS, a
 * shared screen, a browser extension, a support screenshot of devtools) read
 * the credentials. Now the loader sends per provider only WHETHER a key is
 * stored, plus the last four characters so the merchant can recognise which
 * key it is — never the key.
 *
 * Which means the form no longer holds the stored value, so "the field is
 * empty" stops meaning "delete the key": an empty / untouched field leaves the
 * stored key alone, a typed value replaces it, and deletion is an EXPLICIT
 * removal the merchant asks for (`removeApiKeys`). This module is the one
 * place that turns a submitted form into column writes, so the rule cannot
 * drift between the update and the create half of the upsert.
 *
 * Import-free on purpose: the tab imports the types and the field list, the
 * route imports the planner, and a test can run both without a database.
 */

export const API_KEY_FIELDS = [
  "huggingfaceApiKey",
  "geminiApiKey",
  "claudeApiKey",
  "openaiApiKey",
  "grokApiKey",
  "deepseekApiKey",
] as const;

export type ApiKeyField = (typeof API_KEY_FIELDS)[number];

export function isApiKeyField(value: unknown): value is ApiKeyField {
  return typeof value === "string" && (API_KEY_FIELDS as readonly string[]).includes(value);
}

/** What the browser may know about one stored key. */
export interface ApiKeyStatus {
  /** A ciphertext is stored for this provider (readable or not). */
  stored: boolean;
  /** Last four characters of a READABLE key, or null. */
  hint: string | null;
  /** Stored but cannot be decrypted (e.g. a rotated ENCRYPTION_KEY). */
  corrupted: boolean;
}

export type ApiKeyStatusMap = Record<ApiKeyField, ApiKeyStatus>;

/** Keys shorter than this get no hint — four characters of a short key are too much of it. */
const MIN_LENGTH_FOR_HINT = 12;

export function apiKeyHint(plain: string | null | undefined): string | null {
  const trimmed = (plain ?? "").trim();
  if (trimmed.length < MIN_LENGTH_FOR_HINT) return null;
  return trimmed.slice(-4);
}

export function emptyApiKeyStatusMap(): ApiKeyStatusMap {
  const map = {} as ApiKeyStatusMap;
  for (const field of API_KEY_FIELDS) map[field] = { stored: false, hint: null, corrupted: false };
  return map;
}

/**
 * Builds the status map from the stored row. `decrypt` is only called when
 * `withHints` is true — in managed mode nothing is rendered, so nothing is
 * decrypted at all.
 */
export function apiKeyStatusMap(
  row: Partial<Record<ApiKeyField, string | null | undefined>> | null | undefined,
  decrypt: (cipher: string) => { value: string | null; corrupted: boolean },
  withHints: boolean,
): ApiKeyStatusMap {
  const map = emptyApiKeyStatusMap();
  for (const field of API_KEY_FIELDS) {
    const cipher = row?.[field];
    if (!cipher || cipher.trim() === "") continue;
    if (!withHints) {
      map[field] = { stored: true, hint: null, corrupted: false };
      continue;
    }
    const { value, corrupted } = decrypt(cipher);
    map[field] = {
      stored: true,
      hint: corrupted ? null : apiKeyHint(value),
      corrupted: corrupted || !value,
    };
  }
  return map;
}

/** Usable for a call: stored and decryptable. */
export function apiKeyUsable(status: ApiKeyStatus | undefined): boolean {
  return !!status && status.stored && !status.corrupted;
}

/**
 * Parses the `removeApiKeys` form value — a JSON array of field names. Junk is
 * dropped rather than refused: the worst a malformed list can do is delete
 * nothing.
 */
export function parseRemoveApiKeys(raw: FormDataEntryValue | null): ApiKeyField[] {
  if (typeof raw !== "string" || raw.trim() === "") return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.filter(isApiKeyField)));
  } catch {
    return [];
  }
}

/**
 * Column writes for one save. A field the form left empty (or did not send)
 * is ABSENT from the result — the stored key survives. A typed value is
 * encrypted and written; an explicit removal writes null. A typed value wins
 * over a removal of the same field (the merchant typed after pressing remove).
 */
export function planApiKeyWrites(
  submitted: Partial<Record<ApiKeyField, string | null | undefined>>,
  remove: readonly ApiKeyField[],
  encrypt: (plain: string) => string | null,
): Partial<Record<ApiKeyField, string | null>> {
  const writes: Partial<Record<ApiKeyField, string | null>> = {};
  for (const field of API_KEY_FIELDS) {
    const value = (submitted[field] ?? "").trim();
    if (value !== "") {
      writes[field] = encrypt(value);
    } else if (remove.includes(field)) {
      writes[field] = null;
    }
  }
  return writes;
}
