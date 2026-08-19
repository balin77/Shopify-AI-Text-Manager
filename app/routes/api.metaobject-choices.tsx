/**
 * Which entries a metaobject-linked option could still take.
 *
 * A linked option's values are not free text: each one IS a metaobject entry
 * (Shopify's standard colour definition, a custom "material", …). So adding a
 * value means PICKING an entry, and the picker needs the list.
 *
 * -- Why the type is not passed in -------------------------------------------
 * The option carries `linkedMetafield` — a metafield namespace and key like
 * `shopify--color-pattern`. That equals the metaobject TYPE only for Shopify's
 * own standard definitions, where the two happen to be spelled alike; for a
 * custom one it names nothing. What the option's values DO carry is the
 * metaobject GID behind each of them, and the cache knows which type a GID
 * belongs to. So the caller sends one GID it already has and gets back the
 * type plus every entry of it — no guessing at a handle.
 *
 * -- Read from the cache, not from Shopify -----------------------------------
 * These entries are already synced (`Metaobject`), they change rarely, and the
 * picker opens on a click. A live query would pay a round trip for a list the
 * app already holds.
 *
 * The cost is real and is REPORTED rather than hidden: an entry created in
 * Shopify since the last metaobject sync is not in the cache, so the response
 * carries `syncedAt` and the picker says when the list was read. Without that,
 * a missing entry is indistinguishable from one that does not exist, and the
 * merchant goes looking for a bug.
 */

import { data as json, type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { db } from "../db.server";
import { metaobjectSwatchColor } from "~/services/metaobject-choice.shared";

/** How many entries one picker shows. */
const CHOICE_LIMIT = 250;

export interface MetaobjectChoice {
  id: string;
  displayName: string;
  /** A hex colour, when the entry carries one. */
  color?: string;
}

export const loader = async (args: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(args.request);

  const url = new URL(args.request.url);
  const metaobjectId = url.searchParams.get("metaobjectId") ?? "";
  if (!metaobjectId.startsWith("gid://shopify/Metaobject/")) {
    return json({ success: false, type: null, entries: [] }, { status: 400 });
  }

  // No plan gate: this lists entries the merchant can already see on this
  // app's own metaobjects page, and gating it would leave the picker empty
  // rather than protecting anything.
  const anchor = await db.metaobject.findFirst({
    where: { shop: session.shop, id: metaobjectId },
    select: { type: true },
  });
  // An anchor the cache does not know is not an error: the product references
  // an entry that has not been synced. Reported as "no type", so the UI says
  // it could not read the list instead of showing an empty one as if the shop
  // had no colours.
  if (!anchor) return json({ success: false, type: null, entries: [] });

  // Bounded. A shop with thousands of entries of one type would otherwise
  // serialise all of them into one response per popover open — and the picker
  // is a scrollable list with no search, so nobody would reach the end anyway.
  // The cap is REPORTED, never silent.
  const rows = await db.metaobject.findMany({
    where: { shop: session.shop, type: anchor.type },
    // `fields` is the whole JSON blob of every entry and only one hex is taken
    // out of it — but Prisma cannot project into JSON, so it is read and
    // discarded here rather than shipped to the client.
    select: { id: true, displayName: true, handle: true, fields: true, lastSyncedAt: true },
    orderBy: { displayName: "asc" },
    take: CHOICE_LIMIT + 1,
  });
  const truncated = rows.length > CHOICE_LIMIT;
  const shown = truncated ? rows.slice(0, CHOICE_LIMIT) : rows;

  const entries: MetaobjectChoice[] = shown.map((row) => ({
    id: row.id,
    // A blank display name would render as an unclickable gap; the handle is
    // always there and is what Shopify falls back to as well.
    displayName: row.displayName?.trim() || row.handle,
    color: metaobjectSwatchColor(row.fields),
  }));

  return json({
    success: true,
    type: anchor.type,
    entries,
    truncated,
    // The oldest row's stamp: the list is only as fresh as its stalest entry.
    syncedAt: shown.reduce<string | null>(
      (oldest, row) => {
        const stamp = row.lastSyncedAt?.toISOString?.() ?? null;
        if (!stamp) return oldest;
        return !oldest || stamp < oldest ? stamp : oldest;
      },
      null,
    ),
  });
};
