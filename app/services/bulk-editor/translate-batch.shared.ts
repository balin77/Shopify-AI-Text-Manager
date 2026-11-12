/**
 * The pure half of the Batch-API mode of "add missing translations"
 * (PLAN_BULK_TRANSLATE_BATCHING 5). Import-free (apart from types) so the
 * submit path, the collect path, the page's estimate and the tests share it.
 *
 * What the MANIFEST is, and is not. A batch is submitted now and collected up to
 * a day later, by a tick that has no request, no client selection and no
 * memory of the submit. The manifest (one text column on the batch row, ONE
 * writer: the lease holder) is what lets that tick reconstruct the run:
 *
 *  - the cells the packages carried (row, column, languages) with a HASH of the
 *    source text each was asked about and the Shopify digests read at submit
 *    (`expected`, which the fill-only write holds the registration to);
 *  - the requests, each with the SIGNATURE of every item in it, in the order of
 *    the package-local ids (`k1..kN`) the prompt used.
 *
 * It holds NO source text (privacy and size: the collect step re-reads the
 * sources from the cache and the live shop) and NO translation. Results are
 * matched to cells by ITEM SIGNATURE -- (kind, languages, source text) -- not by
 * package or position: the collect step re-plans its own packages from the
 * cells that are still missing, which need not be the packages that were
 * submitted, and an item whose text moved simply has no matching signature.
 */

import type { BulkRowType } from "./columns.shared";

// ─── ids ────────────────────────────────────────────────────────────────────

/**
 * Anthropic's documented `custom_id` rule: 1-64 characters of [A-Za-z0-9_-].
 * From the provider documentation, NOT measured here (the SDK typings carry no
 * pattern), so the builder refuses anything outside it instead of hoping.
 */
export const BATCH_CUSTOM_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `t<taskId>_p` -- ties every request of a batch to the Task that made it. */
export function batchIdPrefix(taskId: string): string {
  return `t${taskId.replace(/[^A-Za-z0-9_-]/g, "")}_p`;
}

export function batchCustomId(idPrefix: string, index: number): string {
  const id = `${idPrefix}${index}`;
  if (!BATCH_CUSTOM_ID_PATTERN.test(id)) throw new Error(`batch custom_id out of the provider's range: ${id.length} characters`);
  return id;
}

// ─── hashing ────────────────────────────────────────────────────────────────

/**
 * A 64-bit-ish content hash as 16 hex characters (two independent 32-bit
 * hashes). Not for security: it keys a lookup inside ONE shop's own batch, and
 * a collision would still have to pass the per-entry verification (numbers,
 * HTML skeleton, protected tokens) before anything is written.
 */
export function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 5381;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = (Math.imul(b, 33) + c) | 0;
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, "0");
  return hex(a) + hex(b);
}

/**
 * The identity of ONE item for matching a result back to a cell: what was
 * asked (kind), in which languages, about which text. NOT the merchant's
 * instructions and NOT the handle's title context -- an answer to the same text
 * in the same languages is a valid translation whichever wording rules were on
 * when it was asked, and keying on them would discard paid results the moment
 * the merchant edits an instruction while the batch waits.
 */
export function itemSignature(item: { kind: string; locales: string[]; source: string }): string {
  const locales = [...new Set(item.locales)].sort().join(",");
  return hash64(`${item.kind}\u0000${locales}\u0000${item.source}`);
}

/** Hash of a cell's source text, to notice that the text moved between submit and collect. */
export function sourceHash(source: string): string {
  return hash64(source.replace(/\r\n/g, "\n").trim());
}

// ─── manifest ───────────────────────────────────────────────────────────────

export interface BatchManifestCell {
  /** rowId */
  r: string;
  /** columnId */
  c: string;
  /** target locales the cell was submitted for */
  l: string[];
  /** hash of the source text at submit */
  h: string;
  /** targetResourceId -> Shopify digest read at submit (the fill-only write's `expected`) */
  e?: Record<string, string>;
}

export interface BatchManifestRequest {
  customId: string;
  kind: string;
  /** Item signatures in the order of the package-local ids k1..kN. */
  items: string[];
  /** `max_tokens` the request was sent with. */
  maxTokens: number;
  /** Estimated input tokens (pessimistic). */
  inputEstimate: number;
}

export interface BatchManifestFailure {
  rowId: string;
  columnId: string;
  message: string;
  units: number;
}

export interface BatchManifest {
  v: 1;
  rowType: BulkRowType;
  moType: string;
  /** Target locales of the whole run. */
  locales: string[];
  primaryLocale: string;
  /** Total units of the run (Task.total). */
  units: number;
  cells: BatchManifestCell[];
  requests: BatchManifestRequest[];
  /** What was settled BEFORE anything was sent (plan-time read): carried into the final result. */
  plan: {
    skippedChanged: number;
    failures: BatchManifestFailure[];
    mismatchesByKey: Record<string, number>;
    /** Units the packages did not carry (productType, an entry that fits no package, over the batch size cap): never started. */
    notStarted: number;
  };
  submittedAt: string;
}

export function serializeManifest(manifest: BatchManifest): string {
  return JSON.stringify(manifest);
}

/** Parse a stored manifest; anything that is not a v1 manifest is `null` (the run is then unreadable, never guessed). */
export function parseManifest(text: string | null | undefined): BatchManifest | null {
  if (!text) return null;
  try {
    const value = JSON.parse(text) as Partial<BatchManifest> | null;
    if (!value || value.v !== 1 || !Array.isArray(value.cells) || !Array.isArray(value.requests)) return null;
    return value as BatchManifest;
  } catch {
    return null;
  }
}

// ─── result bookkeeping ─────────────────────────────────────────────────────

/** Sizes of the whole batch. Anthropic documents 100 000 requests / 256 MB per batch; this stays far below both. */
export const BATCH_MAX_REQUESTS = 10_000;
export const BATCH_MAX_PROMPT_BYTES = 100 * 1024 * 1024;

/** How many synchronous re-asks a collect may spend on entries the batch did not deliver: min(20, 10 % of the packages), at least one. */
export function retryBudgetFor(requestCount: number): number {
  return Math.max(1, Math.min(20, Math.ceil(requestCount * 0.1)));
}

/** Provider-side outcome of one batch, summed. */
export interface BatchOutcomeCounts {
  requests: number;
  succeeded: number;
  errored: number;
  expired: number;
  canceled: number;
  /** Requests with no result line at all (a result stream that stopped early). */
  missing: number;
  /** Succeeded requests whose answer was cut off at the output cap, or could not be parsed. */
  invalid: number;
}
