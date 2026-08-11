import type { data } from "react-router";

/**
 * What our action helpers return.
 *
 * Remix's `json()` returned a `Response`, so every action helper was annotated
 * `Promise<Response>`. React Router 7 removed `json()` in favour of `data()`,
 * which returns a wrapper object rather than a `Response` — so those
 * annotations no longer describe the value.
 *
 * The wrapper's own type is only exported as `UNSAFE_DataWithResponseInit`,
 * which we deliberately do not depend on. Deriving it from `data()` itself
 * gives the same type through the stable public API.
 *
 * Named DataResponse, not ActionResult: ten route modules already export
 * their own `ActionResult` describing that route's action payload union, which
 * is a different concept from this wrapper.
 *
 * Note this carries no payload type, exactly like the `Promise<Response>` it
 * replaces — the shape still flows to the client through
 * `useLoaderData`/`useFetcher` generics on the route module, not through here.
 */
export type DataResponse = ReturnType<typeof data> | Response;
