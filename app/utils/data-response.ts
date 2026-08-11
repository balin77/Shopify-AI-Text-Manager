import type { DataResponse } from "~/types/data-response";

/**
 * Read the payload out of an action helper's result.
 *
 * Under Remix these helpers returned a `Response`, so callers that needed to
 * post-process a result did `await result.json()`. React Router 7's `data()`
 * returns a wrapper holding the value directly — there is no body to parse —
 * while a few helpers still hand back a real `Response`. These two readers
 * cover both shapes so call sites don't have to branch.
 */
export async function readDataPayload<T = unknown>(
  result: DataResponse,
): Promise<T | null> {
  if (result instanceof Response) {
    return (await result.json().catch(() => null)) as T | null;
  }
  return result.data as T;
}

/**
 * Status code of an action helper's result, or `undefined` when it carries
 * none (`data(value)` without an init defaults to 200 downstream).
 */
export function readDataStatus(result: DataResponse): number | undefined {
  if (result instanceof Response) return result.status;
  return result.init?.status;
}
