/**
 * PLAN_CONTENT_CREATION §2.5b–d — the create modal's AI side.
 *
 * ── Why plain `fetch` and not `useFetcher` ──────────────────────────────────
 * `/api/ai` is a resource route the editor already posts to with plain fetch,
 * and this needs something a fetcher cannot give: a PROMISE per call, so the
 * fields can be generated one after another with each result feeding the next
 * one's context. A fetcher exposes its answer through re-renders, which turns
 * "generate four fields in order" into a state machine for no benefit.
 *
 * ── Why the calls are sequential ────────────────────────────────────────────
 * They are not independent. The meta description summarises the description;
 * firing them together would summarise a field that is still empty. The cost
 * is wall-clock on a button the merchant pressed deliberately, and the
 * progress label says which field is being written.
 *
 * ── What it never does ──────────────────────────────────────────────────────
 * Overwrite. "Generate the rest" fills what is EMPTY: a merchant who wrote
 * their own description and wanted help with the meta description must not
 * lose the description to a button whose label says "the rest". A field the
 * merchant filled is skipped, and the result box says how many were written.
 */

import { useCallback, useRef, useState } from "react";
import type { CreatableResource } from "../../config/create-fields.config";
import { createAiSpecFor, LONG_TEXT_KEY_BY_RESOURCE } from "../../config/create-ai.shared";

export interface CreateAiAssistOptions {
  /** Display name of the shop's primary language, e.g. "German". */
  mainLanguage: string;
  /** §0.5 — the editor's own toggle is not in scope here, so the modal owns one. */
  sendImageToAI: boolean;
}

export interface GenerateRestResult {
  /** Only the fields that were EMPTY and got a value. */
  filled: Record<string, string>;
  /** Field keys that failed. Reported, never swallowed. */
  failed: string[];
  /** True when at least one result still over-used the keyword (§3.2). */
  stuffingWarning: boolean;
}

async function postAi(body: Record<string, string>): Promise<Record<string, unknown>> {
  const formData = new FormData();
  for (const [key, value] of Object.entries(body)) formData.set(key, value);
  const response = await fetch("/api/ai", { method: "POST", body: formData });
  // A non-JSON body means the route errored before its own handler ran; the
  // status alone is the only honest thing left to report.
  const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!data) throw new Error(`AI request failed (${response.status})`);
  if (data.success === false) {
    throw new Error(typeof data.error === "string" ? data.error : "AI request failed");
  }
  return data;
}

export function useCreateAiAssist({ mainLanguage, sendImageToAI }: CreateAiAssistOptions) {
  const [busyField, setBusyField] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [altBusy, setAltBusy] = useState(false);

  /**
   * Bumped on every run. A run that finished after the merchant closed the
   * dialog or switched resource must not write its results into the form that
   * is on screen now — the values would arrive with no visible cause.
   */
  const runToken = useRef(0);

  const cancel = useCallback(() => {
    runToken.current += 1;
    setBusyField(null);
    setAltBusy(false);
  }, []);

  const generateRest = useCallback(
    async (
      resource: CreatableResource,
      values: Record<string, string>,
      imageUrl: string,
    ): Promise<GenerateRestResult | null> => {
      const spec = createAiSpecFor(resource);
      if (!spec) return null;

      const token = ++runToken.current;
      setAiError(null);

      const filled: Record<string, string> = {};
      const failed: string[] = [];
      let stuffingWarning = false;

      const title = values.title ?? "";
      const longTextKey = LONG_TEXT_KEY_BY_RESOURCE[resource] ?? "";

      try {
        for (const field of spec.fields) {
          if (token !== runToken.current) return null;
          // Never overwrite. See the header — "the rest" means the rest.
          if ((values[field.createKey] ?? "").trim()) continue;

          setBusyField(field.createKey);
          try {
            // Context grows as the run goes: a meta description written after
            // the description summarises the description, which is the point.
            const contextDescription = longTextKey
              ? filled[longTextKey] ?? values[longTextKey] ?? ""
              : "";
            const data = await postAi({
              action: "generateAIText",
              contentType: spec.contentType,
              // No itemId exists yet — that is precisely why the keyword is
              // passed explicitly below (§2.5d).
              fieldType: field.editorKey,
              currentValue: "",
              contextTitle: title,
              contextDescription,
              mainLanguage,
              explicitKeyword: values.keyword ?? "",
              sendImageToAI: sendImageToAI && imageUrl ? "true" : "false",
              ...(sendImageToAI && imageUrl ? { imageUrl } : {}),
            });
            const generated = typeof data.generatedContent === "string" ? data.generatedContent : "";
            if (generated.trim()) filled[field.createKey] = generated;
            else failed.push(field.createKey);
            if (data.keywordStuffingWarning === true) stuffingWarning = true;
          } catch {
            // Per FIELD, never all-or-nothing: three good fields and one
            // failure is a better outcome than nothing, and the caller lists
            // what did not come through.
            failed.push(field.createKey);
          }
        }
      } finally {
        if (token === runToken.current) setBusyField(null);
      }

      if (token !== runToken.current) return null;
      if (Object.keys(filled).length === 0 && failed.length > 0) {
        setAiError("The AI could not write any of the remaining fields.");
      }
      return { filled, failed, stuffingWarning };
    },
    [mainLanguage, sendImageToAI],
  );

  /**
   * §2.5c — alt text right after the upload.
   *
   * Shopify creates images with no alt text and nothing later reminds anyone,
   * so the moment the image is attached is the only moment this is free. It
   * fills only an EMPTY alt: the library picker returns the file's existing
   * one, and overwriting that would discard a value someone already wrote.
   */
  const generateAltText = useCallback(
    async (resource: CreatableResource, imageUrl: string, title: string): Promise<string | null> => {
      const spec = createAiSpecFor(resource);
      if (!spec || !imageUrl) return null;

      const token = ++runToken.current;
      setAltBusy(true);
      try {
        const data = await postAi({
          action: "generateAltText",
          contentType: spec.contentType,
          imageUrl,
          productTitle: title,
          mainLanguage,
          sendImageToAI: sendImageToAI ? "true" : "false",
        });
        if (token !== runToken.current) return null;
        const altText = typeof data.altText === "string" ? data.altText.trim() : "";
        return altText || null;
      } catch {
        // Silent by design: this one was never asked for. A banner about a
        // convenience that did not happen, on a form the merchant is still
        // filling in, is noise — the alt field simply stays empty and editable.
        return null;
      } finally {
        if (token === runToken.current) setAltBusy(false);
      }
    },
    [mainLanguage, sendImageToAI],
  );

  return {
    /** Create-form key currently being written, or null. */
    busyField,
    generating: busyField !== null,
    altBusy,
    aiError,
    dismissAiError: useCallback(() => setAiError(null), []),
    generateRest,
    generateAltText,
    cancel,
  };
}
