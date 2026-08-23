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
import { translatableCreateFields } from "../config/create-ai.shared";
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
  /**
   * §2.5a/§2.5d — warning CODES decided CLIENT-side and phrased by the banner:
   * what the AI pass could not write before the create, and a chained
   * translate-all that did not finish after it. Separate from `notes` because
   * those arrive from the SERVER already phrased, while a sentence written
   * here would be English for a three-language app.
   */
  warningCodes?: string[];
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
  /**
   * The three sentences this hook produces itself.
   *
   * They were hardcoded English and reached the modal's error banner verbatim,
   * so a German shop read them in English at exactly the moment something had
   * gone wrong. The hook has no i18n of its own; the caller passes them.
   */
  texts?: {
    optionsFailed?: string;
    alreadyCreating?: string;
    createFailed?: string;
  };
  /**
   * §2.5a — the shop's published locales MINUS the primary one.
   *
   * Passed in rather than derived: an empty list here means "nothing to
   * translate into", and the caller is the only place that can tell that apart
   * from a locale lookup that failed (`getCachedShopLocales` resolves with []
   * on a swallowed error). With no targets the chained call is skipped and the
   * create still reports success.
   */
  targetLocales?: string[];
  /** Fired when the chained translate-all finishes, so the caller can
   *  revalidate a SECOND time — the translations land in the DB after the
   *  create's own revalidation has already run. */
  onTranslated?: () => void;
}

export function useCreateItem({
  plan,
  resources,
  counts = {},
  atLimit = false,
  onCreated,
  targetLocales = [],
  onTranslated,
  texts,
}: UseCreateItemOptions) {
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
          setError(typeof data.error === "string" ? data.error : (texts?.optionsFailed || "Could not load the options for this form."));
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

  /**
   * §2.5a — the chained translate-all runs on its OWN fetcher.
   *
   * Sharing the create fetcher would overwrite the create's answer with the
   * translation's before the effect below has read it — and the two answers
   * are read by different rules. A second fetcher also keeps "the item was
   * created" and "its translations are running" as the two separate facts they
   * are: the first is already true when the second is still in flight.
   */
  const translateFetcher = useFetcher<Record<string, unknown>>();
  const [translating, setTranslating] = useState(false);
  /**
   * The answer that was already on the fetcher when this run was submitted.
   *
   * `translateFetcher.data` SURVIVES a completed run, and `translating` is set
   * by us rather than by the router — so between our `setTranslating(true)` and
   * the router flipping the fetcher to "submitting", a render can observe
   * `translating && state === "idle"` with the PREVIOUS run's answer still
   * attached. Consumed as this run's, it would put the previous failure's
   * warning on the new item and then never read the real answer.
   *
   * A counter of our own submissions cannot tell those apart — the fetcher's
   * payload carries no id. Its object IDENTITY can: the router mints a fresh
   * one per response, so "still the object we saw at submit time" is exactly
   * "our answer has not arrived yet".
   */
  const translateDataAtSubmit = useRef<unknown>(null);

  // Resolved by the effect below once the action answers.
  const pendingPayload = useRef<{
    resource: CreatableResource;
    /** The form values, kept so the chained translate-all can carry them. */
    values: Record<string, string>;
    translateAfterwards: boolean;
    /** §2.5d — what the AI pass that ran on this submit could not deliver. */
    aiWarningCodes: string[];
  } | null>(null);

  const create = useCallback(
    (payload: {
      resource: CreatableResource;
      values: Record<string, string>;
      imageUrl: string;
      imageAlt: string;
      ruleSources?: unknown[];
      requestId: string;
      translateAfterwards?: boolean;
      /**
       * §2.5d — warning CODES from the AI pass the modal ran between the click
       * and this call. They belong on the created item's banner: the dialog
       * that could have shown them is closed by the time the create answers.
       */
      aiWarningCodes?: string[];
    }) => {
      setSubmitting(true);
      setError(null);
      setFieldErrors([]);
      setPendingNotice(null);
      pendingPayload.current = {
        resource: payload.resource,
        values: payload.values,
        translateAfterwards: !!payload.translateAfterwards,
        aiWarningCodes: payload.aiWarningCodes ?? [],
      };

      const formData = new FormData();
      formData.set("action", "createContent");
      formData.set("resource", payload.resource);
      formData.set("requestId", payload.requestId);
      if (payload.imageUrl) formData.set("imageUrl", payload.imageUrl);
      if (payload.imageAlt) formData.set("imageAlt", payload.imageAlt);
      // §1.4b — only when rules were actually built. Absent means MANUAL, and
      // the server takes the path that works on every pinned version.
      if (payload.ruleSources?.length) formData.set("ruleSources", JSON.stringify(payload.ruleSources));
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
          : (texts?.alreadyCreating || "This is already being created — please wait a moment rather than submitting again."),
      );
      return;
    }
    if (!result.success) {
      setError(typeof result.error === "string" ? result.error : (texts?.createFailed || "Could not create the item."));
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
      // The AI pass ran BEFORE the create, so whatever it could not write is
      // already known here — and the item exists either way, which is why
      // these are warnings on a success banner rather than an error.
      warningCodes: payload.aiWarningCodes.length > 0 ? [...payload.aiWarningCodes] : undefined,
    };
    setCreated(info);
    setOpenResource(null);
    onCreated?.(info);

    /**
     * §2.5a — create, then translate. In that order, and from HERE.
     *
     * The create handler writes the primary language only. Translating is a
     * chained call of the ONE existing translate-all action on the new id, so
     * it gets the usual `bulkTranslation` task row and the usual progress UI
     * rather than becoming a second translation write path.
     *
     * Skipped when the sync failed: without a cache row the action has no item
     * to write translations against, and the create is still a success.
     */
    if (
      payload.translateAfterwards &&
      info.synced &&
      targetLocales.length > 0 &&
      translatableCreateFields(payload.resource).length > 0
    ) {
      const translateData = new FormData();
      translateData.set("action", "translateAll");
      translateData.set("itemId", info.id);
      translateData.set("targetLocales", JSON.stringify(targetLocales));
      // Values come from the FORM, not from the freshly synced cache: the
      // action reads them off the request, and the merchant's own words are
      // the same ones that were just written to Shopify.
      for (const field of translatableCreateFields(payload.resource)) {
        const value = payload.values[field.createKey];
        if (value?.trim()) translateData.set(field.editorKey, value);
      }
      translateDataAtSubmit.current = translateFetcher.data;
      setTranslating(true);
      translateFetcher.submit(translateData, { method: "POST" });
    }
    // `translateFetcher` is stable across renders (useFetcher), so leaving it
    // out keeps this effect from re-running on every render of the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetcher.data, fetcher.state, onCreated, targetLocales]);

  // The chained translation's own answer. Its failure is reported as a NOTE on
  // the created item, never as a create failure — the object exists either way,
  // and saying otherwise is what produces the duplicate this file guards
  // against everywhere else.
  useEffect(() => {
    if (!translating || translateFetcher.state !== "idle" || !translateFetcher.data) return;
    // The router has not started OUR submission yet — what is attached is the
    // previous run's answer. See the ref's comment.
    if (translateFetcher.data === translateDataAtSubmit.current) return;
    translateDataAtSubmit.current = translateFetcher.data;
    setTranslating(false);
    const failed = translateFetcher.data.success !== true;
    if (failed) {
      // A CODE, phrased by the banner.
      setCreated((prev) =>
        prev ? { ...prev, warningCodes: [...(prev.warningCodes ?? []), "translateChainFailed"] } : prev,
      );
    }
    onTranslated?.();
  }, [translating, translateFetcher.state, translateFetcher.data, onTranslated]);

  // A non-createContent error response (validation rejected before the action
  // tagged it) still has to stop the spinner.
  useEffect(() => {
    if (fetcher.state === "idle" && submitting && fetcher.data && fetcher.data.actionType !== "createContent") {
      setSubmitting(false);
      if (fetcher.data.success === false) {
        setError(typeof fetcher.data.error === "string" ? fetcher.data.error : (texts?.createFailed || "Could not create the item."));
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
    /** §2.5a — the chained translate-all is still running. */
    translating,
    /** The post-create box. Its shape leaves room for the §1.8 undo button. */
    created,
    dismissCreated: useCallback(() => setCreated(null), []),
  };
}
