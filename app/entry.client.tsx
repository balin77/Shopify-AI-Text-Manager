import { RemixBrowser } from "@remix-run/react";
import { startTransition, StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

// Prevent infinite reload loop in Shopify embedded apps
// When the app is loaded in an iframe and there's a session issue,
// this prevents continuous reloading by tracking reload attempts
// Using localStorage (not sessionStorage) to survive F5 reloads
const RELOAD_KEY = 'shopify_app_reload_count';
const RELOAD_TIMESTAMP_KEY = 'shopify_app_reload_timestamp';
const MAX_RELOADS = 2; // Reduced to 2 for faster detection
const RELOAD_WINDOW_MS = 5000; // 5 seconds - shorter window

function checkReloadLoop() {
  try {
    const now = Date.now();
    const timestamp = parseInt(localStorage.getItem(RELOAD_TIMESTAMP_KEY) || '0', 10);
    const reloadCount = parseInt(localStorage.getItem(RELOAD_KEY) || '0', 10);

    console.log('[App] Reload check:', { reloadCount, timestamp, now, timeSinceLastReload: now - timestamp });

    // Reset counter if outside the time window
    if (now - timestamp > RELOAD_WINDOW_MS) {
      console.log('[App] Resetting reload counter (outside time window)');
      localStorage.setItem(RELOAD_KEY, '1');
      localStorage.setItem(RELOAD_TIMESTAMP_KEY, String(now));
      return false;
    }

    // Increment counter
    const newCount = reloadCount + 1;
    localStorage.setItem(RELOAD_KEY, String(newCount));

    console.log('[App] Reload attempt', newCount, 'of', MAX_RELOADS);

    // Check if we've exceeded max reloads
    if (newCount >= MAX_RELOADS) {
      console.error('[App] Infinite reload loop detected. Stopping reloads.');
      return true;
    }

    return false;
  } catch (error) {
    console.error('[App] Error checking reload loop:', error);
    // If localStorage fails, allow the app to load
    return false;
  }
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
    <div style="display: flex; align-items: center; justify-content: center; height: 100vh; font-family: system-ui, sans-serif; text-align: center; padding: 2rem; background: #f6f6f7;">
      <div style="background: white; padding: 3rem; border-radius: 8px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 600px;">
        <h1 style="color: #bf0711; font-size: 2rem; margin-bottom: 1rem;">⚠️ Reload Loop erkannt</h1>
        <p style="color: #666; margin-bottom: 1.5rem; line-height: 1.6;">
          Die App hat mehrere Reload-Versuche innerhalb kurzer Zeit erkannt. Das passiert typischerweise bei:
        </p>
        <ul style="text-align: left; margin: 0 auto 2rem; color: #666; line-height: 1.8;">
          <li>Browser Reload (F5) - nicht unterstützt in Shopify Embedded Apps</li>
          <li>Abgelaufene Session oder Auth-Token</li>
          <li>App Bridge Verbindungsprobleme</li>
        </ul>
        <p style="color: #008060; font-weight: 600; margin-bottom: 1.5rem;">
          ℹ️ Verwende die Navigation innerhalb der App statt Browser-Reload
        </p>
        <button
          onclick="localStorage.removeItem('shopify_app_reload_count'); localStorage.removeItem('shopify_app_reload_timestamp'); window.location.href = window.location.pathname;"
          style="background: #008060; color: white; border: none; padding: 14px 28px; font-size: 16px; border-radius: 6px; cursor: pointer; font-weight: 600; box-shadow: 0 2px 4px rgba(0,128,96,0.2);"
          onmouseover="this.style.background='#006e52'"
          onmouseout="this.style.background='#008060'"
        >
          Session zurücksetzen und neu laden
        </button>
        <p style="color: #999; font-size: 14px; margin-top: 1.5rem;">
          Falls das Problem weiterhin besteht, öffne die App direkt aus dem Shopify Admin.
        </p>
      </div>
    </div>
  `;
}
