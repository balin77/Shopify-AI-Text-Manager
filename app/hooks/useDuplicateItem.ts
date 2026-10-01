/**
 * PLAN_CONTENT_CREATION §1.9 — the SERVER-side half of "create like this one".
 *
 * Only products and collections come through here; pages, articles and blogs
 * are prefilled into the ordinary create form instead (see `useCreateItem`'s
 * `open(resource, prefill)`), because Shopify has no duplicate mutation for
 * them and a copy is not a different operation.
 *
 * The whole reason this is its own hook rather than a branch of `useCreateItem`
 * is that the outcome is shaped differently. `productDuplicate` and
 * `collectionDuplicate` are ASYNCHRONOUS: the answer can be "started, ask
 * later" with no usable id. The create flow's contract — here is your item, it
 * is selected — cannot be honoured, and faking it produces the §1.6 failure in
 * reverse: an item that looks missing, a second click, a copy of the copy.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { CreatableResource } from "../config/create-fields.config";

export interface DuplicateTarget {
  sourceId: string;
  sourceTitle: string;
  resource: Extract<CreatableResource, "product" | "collection">;
}

export interface DuplicateOutcome {
  resource: string;
  /** May be null while Shopify is still assembling the copy. */
  id: string | null;
  title: string;
  handle: string | null;
  /** True when the copy is not finished — the UI must say so, not select it. */
  pending: boolean;
}

export interface UseDuplicateItemOptions {
  onDuplicated?: (outcome: DuplicateOutcome) => void;
}

export function useDuplicateItem({ onDuplicated }: UseDuplicateItemOptions = {}) {
  const fetcher = useFetcher<Record<string, unknown>>();
  const [target, setTarget] = useState<DuplicateTarget | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const request = useCallback((next: DuplicateTarget) => {
    setError(null);
    setTarget(next);
    // A copy needs its own name. Shopify would accept the same title, and the
    // merchant would then have two identical rows in the list with no way to
    // tell which is which.
    setNewTitle(next.sourceTitle ? `${next.sourceTitle} (copy)` : "");
  }, []);

  const cancel = useCallback(() => {
    if (submitting) return;
    setTarget(null);
    setError(null);
  }, [submitting]);

  const confirm = useCallback(() => {
    if (!target || !newTitle.trim()) return;
    setSubmitting(true);
    setError(null);
    inFlight.current = true;

    const formData = new FormData();
    formData.set("action", "duplicateContent");
    formData.set("resource", target.resource);
    formData.set("sourceId", target.sourceId);
    formData.set("newTitle", newTitle.trim());
    fetcher.submit(formData, { method: "POST" });
  }, [target, newTitle, fetcher]);

  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || !inFlight.current) return;
    if (result.actionType !== "duplicateContent" && result.success !== false) return;

    inFlight.current = false;
    setSubmitting(false);

    if (!result.success) {
      setError(typeof result.error === "string" ? result.error : "Could not duplicate the item.");
      return;
    }

    setTarget(null);
    onDuplicated?.({
      resource: String(result.resource),
      id: (result.id as string | null) ?? null,
      title: String(result.title ?? ""),
      handle: (result.handle as string | null) ?? null,
      pending: result.pending === true,
    });
  }, [fetcher.data, fetcher.state, onDuplicated]);

  return { target, newTitle, setNewTitle, request, cancel, confirm, submitting, error };
}
