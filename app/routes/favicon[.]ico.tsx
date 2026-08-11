import { redirect } from "react-router";

// Browsers auto-request /favicon.ico. Without a handler Remix bubbles a
// 404 route error that pollutes the logs. Redirect to the real icon
// instead so the request resolves cleanly and stays cacheable.
export const loader = () =>
  redirect("/app-icon.png", {
    status: 301,
    headers: { "Cache-Control": "public, max-age=86400" },
  });
