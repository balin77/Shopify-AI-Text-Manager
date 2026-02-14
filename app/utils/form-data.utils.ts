/**
 * Safe FormData extraction utilities.
 * Replaces unsafe `formData.get("key") as string` patterns with null-checked alternatives.
 */

/** Returns the string value or "" if missing/not a string. */
export function getFormString(formData: FormData, key: string): string {
  const val = formData.get(key);
  return typeof val === "string" ? val : "";
}

/** Returns the string value or null if missing/not a string. */
export function getFormStringOrNull(formData: FormData, key: string): string | null {
  const val = formData.get(key);
  return typeof val === "string" ? val : null;
}

/** Parses an integer from FormData. Returns null if missing or not a valid number. */
export function getFormInt(formData: FormData, key: string): number | null {
  const val = formData.get(key);
  if (typeof val !== "string") return null;
  const num = parseInt(val, 10);
  return isNaN(num) ? null : num;
}

/** Parses JSON from FormData. Returns null if missing or invalid JSON. */
export function getFormJSON<T = unknown>(formData: FormData, key: string): T | null {
  const val = formData.get(key);
  if (typeof val !== "string") return null;
  try {
    return JSON.parse(val) as T;
  } catch {
    return null;
  }
}
