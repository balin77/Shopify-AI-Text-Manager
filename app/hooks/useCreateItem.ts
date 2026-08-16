/**
 * PLAN_CONTENT_CREATION §1.2/§1.6 — the create flow's client state.
 *
 * Kept out of UnifiedContentEditor because that component is already the
 * largest in the tree, and because the interesting parts here (the gate, the
 * post-create handling) are decisions rather than markup.
 *
 * §1.6 is the part worth reading twice: when Shopify created the object but
 * the cache sync failed, this reports SUCCESS with a note, never an error. The
 * object exists; telling the merchant it does not is what produces a second
 * click and a duplicate — and there is no content delete in this app to undo
 * that with (§0.1).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFetcher } from "react-router";
import type { CreatableResource } from "../config/create-fields.config";
import type { CreateValidationError, CreateFieldDef } from "../config/create-fields.config";

type CreateOption = { value: string; label: string; disabled?: boolean; helpText?: string };
type CreateValidationExtraFields = CreateFieldDef[];
import { evaluateCreateGates, type CreateGateResult } from "../utils/create-gate";
import { createSpecFor } from "../config/create-fields.config";
import { getMaxForResource } from "../utils/planUtils";
import type { Plan, ResourceType } from "../utils/planUtils";

export interface CreatedItemInfo {
  id: string;
  resource: CreatableResource;
  title: string | null;
  /** What Shopify ACTUALLY assigned — differs from the request on a collision. */
  handle: string | null;
  /** False when the object exists on Shopify but the cache did not pick it up. */
  synced: boolean;
  notes: string[];
}

export interface UseCreateItemOptions {
  plan: Plan;
  /** From the tab's `config.createSupport.resources`; empty disables the button. */
  resources: CreatableResource[];
  /** Known counts for the quantity gate. Missing entries mean "unknown", which
   *  does NOT refuse — see evaluateCreateGate. */
  counts?: Partial<Record<ResourceType, number>>;
  /**
   * The tab's own plan-limit signal, already computed by the route with the
   * real counts. Used INSTEAD of a count here so this hook does not re-derive
   * a number the route already knows — but note it only produces the QUANTITY
   * refusal; the content-type refusal is a different message and comes from
   * the plan itself (§1.2).
   */
  atLimit?: boolean;
  /** Called once a create succeeded, so the caller can select + revalidate. */
  onCreated?: (info: CreatedItemInfo) => void;
}

export function useCreateItem({ plan, resources, counts = {}, atLimit = false, onCreated }: UseCreateItemOptions) {
  // useFetcher rather than a bare fetch: posting to a route action goes through
  // React Router's own protocol, and hand-rolling that would break the moment
  // single-fetch encoding changes under us.
  const fetcher = useFetcher<Record<string, unknown>>();
  const [openResource, setOpenResource] = useState<CreatableResource | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<CreateValidationError[]>([]);
  const [created, setCreated] = useState<CreatedItemInfo | null>(null);
  const [pendingNotice, setPendingNotice] = useState<string | null>(null);

  const gates = useMemo(() => {
    const base = evaluateCreateGates(plan, resources, counts);
    if (!atLimit) return base;
    // The route says the shop is at its limit. Only resources that HAVE a
    // quantity limit are affected — a blog has none, so a capped article
    // count must not also block creating the blog to file it under.
    const byResource = base.byResource.map(({ resource, gate }) => {
      if (!gate.allowed) return { resource, gate };
      const spec = createSpecFor(resource);
      if (!spec?.limitResource) return { resource, gate };
      return {
        resource,
        gate: {
          allowed: false as const,
          reason: "planLimit" as const,
          limitResource: spec.limitResource,
          max: getMaxForResource(plan, spec.limitResource),
          current: counts[spec.limitResource] ?? -1,
        },
      };
    });
    return { anyAllowed: byResource.some((r) => r.gate.allowed), byResource };
  }, [plan, resources, counts, atLimit]);

  const gateFor = useCallback(
    (resource: CreatableResource): CreateGateResult =>
      gates.byResource.find((r) => r.resource === resource)?.gate ?? { allowed: false, reason: "unknownResource" },
    [gates],
  );

  /**
   * §1.9 — the prefill half of "create like this one".
   *
   * For pages, articles and blogs Shopify has no duplicate mutation, and none
   * is needed: a copy is just the create form opened with the source's values
   * already in it. It goes through the ordinary createContent path, echo rule
   * and all — no second write path for what is not a different operation.
   */
  const [initialValues, setInitialValues] = useState<Record<string, string>>({});

  const open = useCallback((resource: CreatableResource, prefill?: Record<string, string>) => {
    setError(null);
    setFieldErrors([]);
    setPendingNotice(null);
    setInitialValues(prefill ?? {});
    setOpenResource(resource);
  }, []);

  // §1.3 — two types need a choice that depends on the shop (an article's
  // blog, a metaobject's definition). Fetched when the form opens rather than
  // on every page load: most tabs never need it.
  const [dynamicOptions, setDynamicOptions] = useState<Record<string, CreateOption[]>>({});
  const [extraFieldsByOption, setExtraFieldsByOption] = useState<Record<string, CreateValidationExtraFields>>({});
  const [needsBlogFirst, setNeedsBlogFirst] = useState(false);
  const [optionsLoading, setOptionsLoading] = useState(false);

  useEffect(() => {
    if (!openResource) return;
    if (openResource !== "article" && openResource !== "metaobject") {
      setDynamicOptions({});
      setExtraFieldsByOption({});
      setNeedsBlogFirst(false);
      return;
    }
    let cancelled = false;
    setOptionsLoading(true);
    fetch(`/api/create-options?resource=${encodeURIComponent(openResource)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (!data.success) {
          // A FAILED lookup is not "this shop has no blogs". Without this the
          // form would show an empty required picker and no explanation —
          // and, worse, the "create a blog first" hint would fire on a shop
          // that has plenty. Same rule as everywhere else here: an empty
          // result is not evidence.
          setError(typeof data.error === "string" ? data.error : "Could not load the options for this form.");
          setDynamicOptions({});
          setExtraFieldsByOption({});
          setNeedsBlogFirst(false);
          return;
        }
        setDynamicOptions(data.options ?? {});
        setExtraFieldsByOption(data.extraFieldsByOption ?? {});
        setNeedsBlogFirst(!!data.needsBlogFirst);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setOptionsLoading(false);
      });
    return () => { cancelled = true; };
  }, [openResource]);

  const close = useCallback(() => {
    setOpenResource(null);
    setError(null);
    setFieldErrors([]);
  }, []);

  // Resolved by the effect below once the action answers.
  const pendingPayload = useRef<{ resource: CreatableResource } | null>(null);

  const create = useCallback(
    (payload: {
      resource: CreatableResource;
      values: Record<string, string>;
      imageUrl: string;
      imageAlt: string;
      requestId: string;
    }) => {
      setSubmitting(true);
      setError(null);
      setFieldErrors([]);
      setPendingNotice(null);
      pendingPayload.current = { resource: payload.resource };

      const formData = new FormData();
      formData.set("action", "createContent");
      formData.set("resource", payload.resource);
      formData.set("requestId", payload.requestId);
      if (payload.imageUrl) formData.set("imageUrl", payload.imageUrl);
      if (payload.imageAlt) formData.set("imageAlt", payload.imageAlt);
      // Prefixed so the server can tell a field value apart from a control
      // field without keeping a second list of reserved names.
      for (const [key, value] of Object.entries(payload.values)) {
        if (value !== undefined && value !== null) formData.set(`value.${key}`, value);
      }

      fetcher.submit(formData, { method: "POST" });
    },
    [fetcher],
  );

  // One place interprets the action's answer, so the "created but not synced"
  // rule (§1.6) cannot be applied in one branch and forgotten in another.
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle") return;
    if (result.actionType !== "createContent") return;
    const payload = pendingPayload.current;
    if (!payload) return;
    pendingPayload.current = null;
    setSubmitting(false);

    if (result.pending) {
      // The same request is already running (§1.7). Not an error — but saying
      // nothing at all just stops the spinner, which is exactly what invites
      // the extra click this guard exists to absorb.
      setPendingNotice(
        typeof result.message === "string"
          ? result.message
          : "This is already being created — please wait a moment rather than submitting again.",
      );
      return;
    }
    if (!result.success) {
      setError(typeof result.error === "string" ? result.error : "Could not create the item.");
      if (Array.isArray(result.fieldErrors)) setFieldErrors(result.fieldErrors as CreateValidationError[]);
      return;
    }

    const info: CreatedItemInfo = {
      id: String(result.id),
      resource: payload.resource,
      title: (result.title as string | null) ?? null,
      handle: (result.handle as string | null) ?? null,
      // §1.6 — a failed sync is a NOTE, not a failure.
      synced: result.synced !== false,
      notes: Array.isArray(result.notes) ? (result.notes as string[]) : [],
    };
    setCreated(info);
    setOpenResource(null);
    onCreated?.(info);
  }, [fetcher.data, fetcher.state, onCreated]);

  // A non-createContent error response (validation rejected before the action
  // tagged it) still has to stop the spinner.
  useEffect(() => {
    if (fetcher.state === "idle" && submitting && fetcher.data && fetcher.data.actionType !== "createContent") {
      setSubmitting(false);
      if (fetcher.data.success === false) {
        setError(typeof fetcher.data.error === "string" ? fetcher.data.error : "Could not create the item.");
        if (Array.isArray(fetcher.data.fieldErrors)) setFieldErrors(fetcher.data.fieldErrors as CreateValidationError[]);
      }
    }
  }, [fetcher.state, fetcher.data, submitting]);

  return {
    /** Whether the "+" button is offered at all (the tab supports creating). */
    supported: resources.length > 0,
    /** Whether it is ENABLED. Disabled-with-a-reason, never hidden. */
    anyAllowed: gates.anyAllowed,
    gates: gates.byResource,
    gateFor,
    openResource,
    open,
    close,
    create,
    submitting,
    error,
    pendingNotice,
    fieldErrors,
    initialValues,
    dynamicOptions,
    extraFieldsByOption,
    optionsLoading,
    /** §1.7 — an article needs a blog, and this shop has none yet. */
    needsBlogFirst,
    /** The post-create box. Its shape leaves room for the §1.8 undo button. */
    created,
    dismissCreated: useCallback(() => setCreated(null), []),
  };
}
