/**
 * What a collection-membership picker offers, and which of its rows are locked.
 *
 * Two surfaces pick memberships — the single editor's `CollectionsField` and
 * the bulk grid's collections cell — and they have to agree row for row,
 * because the SERVER then applies one diff (`diffCollectionMembership`) to
 * whatever either of them sends. A picker that decides a row differently from
 * that diff offers exactly the change the save then refuses, and on an atomic
 * `productUpdate` that refusal takes the merchant's text edits with it.
 *
 * Client-safe and pure: the grid builds this per rendered cell.
 */

import { resolveMembershipAutomated } from "./content-attributes.shared";

export interface CollectionPickerOption {
  id: string;
  title: string;
  /** `null` ⇒ never attribute-synced: unknown, which the picker LOCKS. */
  automated: boolean | null;
}

export interface CollectionPickerMembership {
  collectionId: string;
  collectionTitle: string;
  automated: boolean | null;
}

/**
 * The shop's collections UNION the product's own memberships.
 *
 * The union is the point: a membership whose collection the cache never stored
 * (the collection cache is capped by the plan) would otherwise be invisible —
 * and invisible means unticked, which the diff reads as "remove it". Its title
 * comes from `ProductCollection.collectionTitle`, mirrored per membership for
 * exactly this case.
 *
 * Automated-ness is decided by `resolveMembershipAutomated`, CALLED rather than
 * restated: the two flags are stale in different directions, a positive from
 * either wins, and that is the ladder the server runs too.
 *
 * NOT sorted here — ordering by title is a locale question (`compareStrings`),
 * and this module stays free of the app's i18n so both callers can sort with
 * their own locale.
 */
export function collectionPickerRows(
  options: readonly CollectionPickerOption[] | null | undefined,
  memberships: readonly CollectionPickerMembership[],
): CollectionPickerOption[] {
  const byId = new Map<string, CollectionPickerOption>();
  for (const option of options ?? []) byId.set(option.id, option);
  for (const membership of memberships) {
    const existing = byId.get(membership.collectionId);
    byId.set(membership.collectionId, {
      id: membership.collectionId,
      title: existing?.title || membership.collectionTitle || membership.collectionId,
      automated: resolveMembershipAutomated(existing?.automated, membership.automated),
    });
  }
  return [...byId.values()];
}

/**
 * The membership list as ONE canonical string: collection GIDs, de-duplicated,
 * SORTED, comma-joined — the shape the editor's flat value map has always used
 * for this field, made order-independent.
 *
 * The grid needs the sort and the editor never did: the grid decides "is this
 * cell dirty" by comparing two strings, and the same set ticked in a different
 * order would otherwise read as an edit and be saved as one.
 */
export function canonicalCollectionIds(ids: Iterable<string>): string {
  const unique = new Set<string>();
  for (const raw of ids) {
    const id = raw.trim();
    if (id) unique.add(id);
  }
  return [...unique].sort().join(",");
}

/** A Collection GID — the only token a membership cell may carry. */
const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;

/**
 * The bulk grid's reading of a membership cell — STRICT where the editor's is
 * lenient, and the difference is the whole point.
 *
 * The editor's `parseCollectionIds` drops every token that is not a GID, which
 * is right for a value map only its own picker ever writes. A grid cell has two
 * more writers: a rectangular PASTE and a CSV import, both of which carry
 * whatever text the merchant had. Under the lenient reading a pasted
 * "Sale, Winter" parses to NO collections, and the membership diff then saves
 * that as "leave every manual collection" — the product silently disappears
 * from its collections. So one unreadable token refuses the whole cell.
 *
 * An EMPTY cell is still a valid answer: it is what un-ticking every row in the
 * picker produces, and it means "no manual collections".
 */
export function parseGridCollectionIds(
  value: string,
): { ok: true; ids: string[] } | { ok: false; bad: string[] } {
  const tokens = value
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);
  const bad = tokens.filter((token) => !COLLECTION_GID.test(token));
  if (bad.length > 0) return { ok: false, bad };
  return { ok: true, ids: [...new Set(tokens)] };
}
