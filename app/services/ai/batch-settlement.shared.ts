/**
 * The vocabulary of the SETTLEMENT transport (PLAN_BULK_TRANSLATE_BATCHING
 * 19.3) -- types and errors only, no secret, no import of anything that could
 * hold one.
 *
 * Settling a provider batch (retrieve it, read its results, cancel it, delete
 * the files it left behind) has to keep working after the shop left the state
 * in which a NEW AI call would have been allowed: consent withdrawn, key
 * rotated, budget spent. So it cannot go through the normal resolver -- and it
 * must not become a way to use the operator key for anything else. The answer
 * is a restricted transport object that exposes exactly the four operations
 * below and nothing else; the key stays in a closure inside
 * ai-credentials.server.ts (the one module that may hold it).
 *
 * The provider calls behind the four operations arrive with the poller
 * (next phase); until then the default implementation throws
 * `SettlementNotImplementedError`, which callers treat as "could not reach the
 * provider" (best effort, logged).
 */

/** What the transport needs to know about a batch row -- a structural subset of `BulkTranslateBatch`. */
export interface SettlementBatchRow {
  id: string;
  taskId: string;
  shop: string;
  /** "claude" | "openai" (the only providers with a batch API here). */
  provider: string;
  /** "managed" | "byo" -- the SOURCE recorded at submit; never re-derived. */
  source: string;
  /** Managed credential role recorded at submit: "default" | "failover". */
  role: string;
  /** Provider batch ids this run created (JSON array of strings). */
  batchIds: unknown;
  /** Provider files this run uploaded (JSON array of strings). */
  fileIds?: unknown;
}

export type SettlementRefusalReason =
  | "shopMismatch"
  | "unknownSource"
  | "unsupportedProvider"
  /** Kill switch: MANAGED_AI_ENABLED is not "true" in this deployment. */
  | "managedDisabled"
  /** Dev/custom-app build: never serves the operator key (staging with a production DB copy). */
  | "devBuild"
  /** No operator credential configured for the recorded role. */
  | "noCredential"
  /** The operator credential of that role now belongs to a different provider. */
  | "providerChanged"
  /** BYO: the merchant's key for the recorded provider is gone. */
  | "ai_key_missing";

export type SettlementDecision =
  | { ok: true; source: "managed" | "byo"; role: string; transport: SettlementTransport }
  | { ok: false; reason: SettlementRefusalReason };

/** Provider-reported state of one batch, normalised across providers. */
export interface SettlementBatchStatus {
  /** The provider's own word (`in_progress`, `ended`, `completed`, ...). */
  providerStatus: string;
  /** No more results will appear. */
  ended: boolean;
  /** The provider is cancelling it. */
  canceling?: boolean;
  requestCounts?: { total?: number; succeeded?: number; errored?: number; expired?: number; canceled?: number };
  /** OpenAI: output / error files. Registered with the transport so they may be deleted. */
  outputFileId?: string | null;
  errorFileId?: string | null;
  /** ISO timestamp the provider will drop the batch. */
  expiresAt?: string | null;
}

/** One request's outcome, normalised across providers. */
export interface SettlementResultItem {
  customId: string;
  outcome: "succeeded" | "errored" | "expired" | "canceled";
  text?: string;
  /** Output hit the token cap: the whole request is invalid. */
  truncated?: boolean;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
  error?: string;
}

/** The provider calls the transport may make. Implemented in the next phase. */
export interface SettlementProviderOps {
  retrieve(batchId: string): Promise<SettlementBatchStatus>;
  results(batchId: string, hint?: { outputFileId?: string | null; errorFileId?: string | null }): AsyncIterable<SettlementResultItem>;
  cancel(batchId: string): Promise<SettlementBatchStatus>;
  deleteFile(fileId: string): Promise<void>;
}

/**
 * The ONLY four things a settlement may do. No `apiKey`, no `config`, no
 * generic `request`; the object is frozen. A test pins the key set.
 */
export interface SettlementTransport {
  retrieve(batchId: string): Promise<SettlementBatchStatus>;
  results(batchId: string): AsyncIterable<SettlementResultItem>;
  cancel(batchId: string): Promise<SettlementBatchStatus>;
  deleteFile(fileId: string): Promise<void>;
}

export const SETTLEMENT_TRANSPORT_METHODS = ["retrieve", "results", "cancel", "deleteFile"] as const;

/** A batch id or file id the batch row does not name: refused before any provider call. */
export class SettlementAccessError extends Error {
  readonly code = "SETTLEMENT_ACCESS_DENIED" as const;
  constructor(
    readonly reason: "batchNotInManifest" | "fileNotOwned",
    message: string,
  ) {
    super(message);
    this.name = "SettlementAccessError";
  }
}

/** The provider call behind an operation is not built yet (Phase 2, next step). */
export class SettlementNotImplementedError extends Error {
  readonly code = "SETTLEMENT_NOT_IMPLEMENTED" as const;
  constructor(provider: string, operation: string) {
    super(`Batch settlement for ${provider} (${operation}) is not implemented yet.`);
    this.name = "SettlementNotImplementedError";
  }
}

/** Parse a JSON column that should hold a list of strings; anything else is an empty list. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.length > 0) : [];
}
