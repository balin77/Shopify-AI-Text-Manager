/**
 * A primary save carries EVERY field of the form, changed or not. A field the merchant did not
 * change is a PASSENGER: it carries no intent, so writing it can only be a no-op (Shopify already
 * holds that text) or the bug (Shopify holds a different text by now, and the old one is written
 * back without anyone being told). Whether Shopify "now" holds something else cannot be decided
 * from the client's reads - a delayed read of the old text is indistinguishable from someone
 * changing it back - so the decision is not made by comparing values at all: the client names its
 * passengers and the server does not write them. Same effect where nothing moved, and the one
 * wrong write is impossible by construction (no read, no normalisation, no false conflict).
 *
 * Import-free: used by the editor (client) and by the content action (server).
 */

/** The form field that carries the passengers' keys as a JSON list. */
export const PASSENGER_FIELDS_KEY = "passengerFields";

/** A field definition as far as this module needs it. */
export interface PassengerFieldDef {
  key: string;
  /** Empty for a merchandising attribute (it has its own `changedAttributeFields` gate). */
  translationKey?: string;
  type?: string;
}

/** Resource types whose primary save does not take passengers (own field shape / single field). */
const NO_PASSENGER_RESOURCE_TYPES = new Set(["Metaobject", "ShopPolicy"]);

/** Whether a primary save of this kind names passengers at all. */
export function savesNamePassengers(resourceType: string, isThemeContent: boolean): boolean {
  return !isThemeContent && !NO_PASSENGER_RESOURCE_TYPES.has(resourceType);
}

/**
 * The keys a primary save sends without the merchant having changed them: sent, a translatable
 * content field (attributes and images follow their own gates), not named in `changedFields`.
 */
export function passengerKeysOf(
  sentKeys: Iterable<string>,
  changedFields: readonly string[],
  definitions: readonly PassengerFieldDef[],
): string[] {
  const sent = new Set(sentKeys);
  const changed = new Set(changedFields);
  const out: string[] = [];
  for (const def of definitions) {
    if (!def.translationKey) continue;
    if (def.type === "themeImage") continue;
    if (!sent.has(def.key) || changed.has(def.key)) continue;
    out.push(def.key);
  }
  return out;
}

/** Parse the list a form carries; anything unreadable names no passenger (the field is written as before). */
export function parsePassengerKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : [];
  } catch {
    return [];
  }
}

/** The form field naming keys that are sent UNANNOUNCED and meant to be WRITTEN (the server ignores it). */
export const WRITTEN_UNANNOUNCED_KEY = "writtenUnannounced";

/**
 * A queued form stops announcing a key (a carry-only announcement the refused carrier made unnecessary):
 * the text stays WRITTEN, only the purge/re-translation goes. It is not a passenger: the merchant typed
 * it back over a carrier that may have written something else, and that typing is an intent.
 */
export function markWrittenUnannounced(formData: FormData, key: string): void {
  const list = parsePassengerKeys(formData.get(WRITTEN_UNANNOUNCED_KEY) as string | null);
  if (list.includes(key)) return;
  formData.set(WRITTEN_UNANNOUNCED_KEY, JSON.stringify([...list, key]));
}

/**
 * The server's half: a copy of the form without the passengers' values. A key the form ALSO names in
 * `changedFields` is not a passenger (the announcement is the merchant's intent and wins). Returns the
 * form to work with and the keys left out.
 */
export function withoutPassengers(
  formData: FormData,
  allowedKeys: ReadonlySet<string>,
): { form: FormData; dropped: string[]; droppedValues: Record<string, string> } {
  const passengers = parsePassengerKeys(formData.get(PASSENGER_FIELDS_KEY) as string | null);
  if (passengers.length === 0) return { form: formData, dropped: [], droppedValues: {} };
  const changed = new Set(parsePassengerKeys(formData.get("changedFields") as string | null));
  const dropped = passengers.filter((key) => allowedKeys.has(key) && !changed.has(key) && formData.has(key));
  if (dropped.length === 0) return { form: formData, dropped: [], droppedValues: {} };
  const drop = new Set(dropped);
  const form = new FormData();
  for (const [key, value] of formData.entries()) if (!drop.has(key)) form.append(key, value);
  const droppedValues: Record<string, string> = {};
  for (const key of dropped) droppedValues[key] = String(formData.get(key));
  return { form, dropped, droppedValues };
}
