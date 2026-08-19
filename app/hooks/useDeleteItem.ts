/**
 * Client state for the ONE delete path, used by both of its entrances:
 * the item list's delete button, and the post-create undo (§1.8).
 *
 * The undo goes through the SAME action and the same confirmation as any other
 * delete. It is tempting to let it skip the dialog — the merchant just created
 * the thing, surely they know what it is — but "I clicked create by mistake"
 * and "I clicked undo by mistake" are the same class of slip, and the second
 * one destroys work while the first only makes some.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { DeletableResource } from "../config/create-fields.config";

export interface DeleteTarget {
  id: string;
  title: string;
  resource: DeletableResource;
  /** Set when this delete undoes a create — used only for wording. */
  isUndo?: boolean;
}

export interface UseDeleteItemOptions {
  /** Called after Shopify confirmed and the cache was purged. */
  onDeleted?: (target: DeleteTarget, info: { cascadedArticles: number }) => void;
  /**
   * Turns a server `errorKey` into a sentence in the merchant's language.
   *
   * A refusal this dialog shows is read by a person, and the server has no
   * business phrasing it: the app ships in three languages and the action is
   * shared. Without a resolver the server's `error` is shown as before, so a
   * caller that does not care loses nothing.
   */
  translateError?: (errorKey: string) => string | undefined;
}

export function useDeleteItem({ onDeleted, translateError }: UseDeleteItemOptions = {}) {
  const fetcher = useFetcher<Record<string, unknown>>();
  const [target, setTarget] = useState<DeleteTarget | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<DeleteTarget | null>(null);

  const request = useCallback((next: DeleteTarget) => {
    setError(null);
    setTarget(next);
  }, []);

  const cancel = useCallback(() => {
    if (deleting) return;
    setTarget(null);
    setError(null);
  }, [deleting]);

  const confirm = useCallback(() => {
    if (!target) return;
    setDeleting(true);
    setError(null);
    pending.current = target;

    const formData = new FormData();
    formData.set("action", "deleteContent");
    formData.set("resource", target.resource);
    formData.set("resourceId", target.id);
    // The unified handler validates itemId as a GID when present; sending it
    // keeps the request shaped like every other action's.
    formData.set("itemId", target.id);
    fetcher.submit(formData, { method: "POST" });
  }, [target, fetcher]);

  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle") return;
    const inFlight = pending.current;
    if (!inFlight) return;

    // Another action's response — not ours to interpret.
    if (result.actionType !== "deleteContent" && result.success !== false) return;

    pending.current = null;
    setDeleting(false);

    if (!result.success) {
      // Nothing was removed — the dialog stays open with the reason, because
      // closing it would read as "done". A translated `errorKey` wins over the
      // server's own wording where the caller supplied a resolver.
      const key = typeof result.errorKey === "string" ? result.errorKey : null;
      const translated = key ? translateError?.(key) : undefined;
      setError(
        translated ?? (typeof result.error === "string" ? result.error : "Could not delete the item."),
      );
      return;
    }

    setTarget(null);
    onDeleted?.(inFlight, { cascadedArticles: Number(result.cascadedArticles ?? 0) });
  }, [fetcher.data, fetcher.state, onDeleted, translateError]);

  return { target, request, cancel, confirm, deleting, error };
}
