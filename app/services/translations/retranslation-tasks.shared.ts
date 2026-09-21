/**
 * The id(s) of the DETACHED re-translation runs ONE save started, on their way
 * from the server to the page that is still open.
 *
 * The bulk grid already watches its runs (`retranslation.taskIds`, read by
 * `useBackgroundTaskRefresh`). Every OTHER surface threw the same answer away:
 * a primary save in the content editor, in the metaobjects tab, on a theme
 * group or on a menu hands its foreign languages to a Task-tracked AI run that
 * finishes minutes later, and nothing told the page when — so the merchant sat
 * in front of empty foreign fields for translations that were already on their
 * way and read a working feature as a broken one.
 *
 * This is the ONE spelling those responses use. Seven save paths write it and
 * four surfaces read it, which is exactly how a `taskId` and a `taskIds` would
 * otherwise have ended up side by side.
 *
 * Client-safe: no server imports, and the one constant it borrows comes from
 * `task-watch.shared.ts`, which is import-free for the same reason.
 */

import { MAX_TASK_STATUS_IDS } from "../tasks/task-watch.shared";

/** The response field. One name, everywhere. */
export const RETRANSLATION_TASK_IDS_FIELD = "retranslationTaskIds" as const;

/**
 * A save can start SEVERAL runs — a product's own fields, its alt texts and its
 * sub-resources are three groups and three Task rows — so this is always a
 * list, never a single id.
 */
export interface RetranslationTaskCarrier {
  retranslationTaskIds?: string[];
}

/**
 * Fold whatever the repair sites answered into ONE deduplicated list.
 *
 * Takes ids and lists of ids, so a caller can pass a nested result straight
 * through. Deduplicated because two repairs of one save can legitimately be
 * handed the same row, and bounded by the poll route's own cap — a watch set is
 * a union across saves and the hook chunks by that number anyway, so nothing is
 * gained by putting more than one call's worth on the wire at once.
 */
export function collectRetranslationTaskIds(
  ...values: Array<string | null | undefined | readonly (string | null | undefined)[]>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const list = Array.isArray(value) ? value : [value as string | null | undefined];
    for (const id of list) {
      if (typeof id !== "string") continue;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      if (out.length < MAX_TASK_STATUS_IDS) out.push(trimmed);
    }
  }
  return out;
}

/**
 * Read the field back off an arbitrary response object.
 *
 * DEFENSIVE by design: the client reads this out of `fetcher.data`, whose shape
 * differs per surface and which is `undefined` for most of a page's life. An
 * unreadable answer is an EMPTY list — never a poll, which is the one direction
 * that costs nothing: a surface that started no run must not poll at all.
 */
export function readRetranslationTaskIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const raw = (value as Record<string, unknown>)[RETRANSLATION_TASK_IDS_FIELD];
  if (!Array.isArray(raw)) return [];
  return collectRetranslationTaskIds(raw as Array<string | null | undefined>);
}
