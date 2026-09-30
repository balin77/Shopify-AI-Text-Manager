/**
 * Managed-AI refusals on entry points that are not `/api/ai`.
 *
 * `aiRefusalResponse` (api-ai-handlers/shared.ts) is THE pre-check: it answers
 * with a coded JSON (`AI_BUDGET_EXCEEDED`, `AI_TASTER_EXHAUSTED`,
 * `AI_CONSENT_REQUIRED`, `AI_TEMPORARILY_UNAVAILABLE`, or BYO's no-key 409)
 * before a Task row or an AI call exists. Two things are missing for the
 * content/templates actions and live here:
 *
 * - `withRefusalShape` echoes the fields the calling route's client reads an
 *   error by (`actionType`, `fieldType`), so a refusal lands where that
 *   action's own error would have landed (a field error for translateField, a
 *   banner elsewhere) instead of a generic one.
 * - `managedRefusalResponseFromError` turns a `ManagedAiRefusedError` that is
 *   THROWN mid-run (the budget ran out between the pre-check and the call)
 *   into the same coded JSON, instead of a raw 500 or N failed locales.
 */
import { data as json } from "react-router";
import type { AISettings } from "@prisma/client";
import { aiRefusalResponse, managedRefusalResponse } from "~/routes/api-ai-handlers/shared";
import { isManagedRefusal } from "../../src/services/ai.service";
import type { DataResponse } from "~/types/data-response";

type Extra = Record<string, unknown>;

/** Merge `extra` into a refusal body, keeping its status. A raw Response is returned as is. */
export function withRefusalShape(refusal: DataResponse, extra: Extra): DataResponse {
  if (refusal instanceof Response) return refusal;
  const wrapped = refusal as { data?: unknown; init?: ResponseInit | null };
  const body = wrapped.data && typeof wrapped.data === "object" ? (wrapped.data as Extra) : {};
  return json({ ...extra, ...body }, wrapped.init ?? undefined);
}

/**
 * Pre-check for an AI action: null when the call may proceed, otherwise the
 * coded refusal shaped for the route.
 */
export async function aiRefusalFor(
  settings: AISettings | null,
  shop: string,
  extra: Extra = {},
): Promise<DataResponse | null> {
  const refusal = await aiRefusalResponse(settings, shop);
  return refusal ? withRefusalShape(refusal, extra) : null;
}

/**
 * A managed refusal thrown during a run → the coded JSON. Returns null for any
 * other error, so the caller's own catch keeps handling it.
 *
 * Built by `managedRefusalResponse` — the same builder `/api/ai` answers a
 * mid-call refusal with — so one refusal never carries two codes.
 */
export function managedRefusalResponseFromError(
  error: unknown,
  settings: AISettings | null,
  extra: Extra = {},
): DataResponse | null {
  if (!isManagedRefusal(error)) return null;
  return withRefusalShape(
    managedRefusalResponse(error.reason, settings, {
      usedMicros: error.usedMicros,
      limitMicros: error.limitMicros,
    }),
    extra,
  );
}

/**
 * The body and status of a refusal, for a route whose client reads its own
 * response shape (e.g. `{ ok: false, error }`) rather than `{ success, error }`.
 */
export function refusalPayload(refusal: DataResponse): {
  error: string;
  code?: string;
  status: number;
} {
  if (refusal instanceof Response) {
    return { error: "AI request refused", status: refusal.status };
  }
  const wrapped = refusal as { data?: unknown; init?: ResponseInit | null };
  const body = (wrapped.data && typeof wrapped.data === "object" ? wrapped.data : {}) as {
    error?: unknown;
    code?: unknown;
  };
  return {
    error: typeof body.error === "string" && body.error ? body.error : "AI request refused",
    ...(typeof body.code === "string" ? { code: body.code } : {}),
    status: wrapped.init?.status ?? 409,
  };
}
