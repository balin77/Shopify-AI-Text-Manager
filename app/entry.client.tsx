import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

// Prevent infinite reload loop in Shopify embedded apps
// When the app is loaded in an iframe and there's a session issue,
// this prevents continuous reloading by tracking reload attempts
const RELOAD_KEY = 'shopify_app_reload_count';
const RELOAD_TIMESTAMP_KEY = 'shopify_app_reload_timestamp';
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 10000; // 10 seconds

function checkReloadLoop() {
  const now = Date.now();
  const timestamp = parseInt(sessionStorage.getItem(RELOAD_TIMESTAMP_KEY) || '0', 10);
  const reloadCount = parseInt(sessionStorage.getItem(RELOAD_KEY) || '0', 10);

  // Reset counter if outside the time window
  if (now - timestamp > RELOAD_WINDOW_MS) {
    sessionStorage.setItem(RELOAD_KEY, '1');
    sessionStorage.setItem(RELOAD_TIMESTAMP_KEY, String(now));
    return false;
  }

  // Increment counter
  const newCount = reloadCount + 1;
  sessionStorage.setItem(RELOAD_KEY, String(newCount));

  // Check if we've exceeded max reloads
  if (newCount >= MAX_RELOADS) {
    console.error('[App] Infinite reload loop detected. Stopping reloads.');
    return true;
  }

  return false;
}

// Check for reload loop before hydrating
if (!checkReloadLoop()) {
  startTransition(() => {
    hydrateRoot(
      document,
      <StrictMode>
        <RemixBrowser />
      </StrictMode>
    );
  });
} else {
  // Show error message instead of reloading
  document.body.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: system-ui, sans-serif; text-align: center; padding: 2rem;">
      <div>
        <h1 style="color: #bf0711; font-size: 2rem; margin-bottom: 1rem;">Reload Loop Detected</h1>
        <p style="color: #666; margin-bottom: 2rem;">The app encountered multiple reload attempts. This usually happens when:</p>
        <ul style="text-align: left; max-width: 500px; margin: 0 auto 2rem; color: #666;">
          <li>Session expired</li>
          <li>Browser cache issues</li>
          <li>App Bridge connection problems</li>
        </ul>
        <button
          onclick="sessionStorage.clear(); window.location.reload();"
          style="background: #008060; color: white; border: none; padding: 12px 24px; font-size: 16px; border-radius: 4px; cursor: pointer;"
        >
          Clear Session and Retry
        </button>
      </div>
    </div>
  `;
}
