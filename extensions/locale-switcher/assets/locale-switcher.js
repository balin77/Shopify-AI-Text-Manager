/*
 * Storefront Language & Currency switcher controller.
 *
 * Progressive enhancement only — the underlying control is one or two native
 * Shopify `localization` forms with real <select>s and a <noscript> submit
 * button, so it already works with JS disabled. This controller:
 *   1. auto-submits the relevant form when its <select> changes,
 *   2. optionally relocates the widget into the theme header/footer,
 *   3. drops a localStorage breadcrumb of the last manual choice (Shopify
 *      itself persists the real preference via its localization cookie).
 *
 * The `change` listener is bound to the custom element itself (event
 * delegation), so it survives the element being moved into the header/footer
 * — a DOM move keeps a node's own listeners, and disconnectedCallback is
 * deliberately a no-op so the relocation move cannot tear the handler down.
 */
class CpLocaleSwitcher extends HTMLElement {
  connectedCallback() {
    // Relocation (appendChild) re-fires connectedCallback; the guard makes
    // that re-entry a no-op so we never double-init.
    if (this._initialized) return;
    this._initialized = true;
    this._debug = this.dataset.debug === '1';

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init(), { once: true });
    } else {
      this._init();
    }
  }

  disconnectedCallback() {
    // Intentionally empty: the element is moved (header/footer relocation)
    // rather than destroyed, and a delegated listener on `this` travels with
    // the node. Tearing down here would kill auto-submit after relocation.
  }

  _log(...a) { if (this._debug) console.info('[cp-locale-switcher]', ...a); }
  _warn(...a) { if (this._debug) console.warn('[cp-locale-switcher]', ...a); }

  _init() {
    if (!this.querySelector('form.cp-locale-switcher__form')) {
      this._warn('no localization form found — aborting');
      return;
    }

    this._relocate();

    // Delegated on the element itself so it keeps working after relocation.
    this._onChange = (e) => {
      const sel = e.target;
      if (!sel || sel.tagName !== 'SELECT' || !sel.form) return;
      this._remember(sel);
      this._log('submitting', sel.dataset.kind, '=', sel.value);
      // Submit the SELECT'S OWN form (language and country are separate
      // Shopify localization forms). Shopify applies the change and sets its
      // own persistence cookie on the redirect.
      const form = sel.form;
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
    };
    this.addEventListener('change', this._onChange);
  }

  /* Persist a non-authoritative breadcrumb (analytics / debugging only —
     Shopify's cookie is the source of truth). Best-effort. */
  _remember(sel) {
    try {
      const key = sel.dataset.kind === 'language'
        ? 'cp_ls_language'
        : 'cp_ls_country';
      window.localStorage.setItem(key, sel.value);
    } catch (_) { /* storage may be unavailable (private mode, etc.) */ }
  }

  /* For header/footer placement, move the widget into the theme's container.
     Floating positions are handled purely by CSS and need no relocation. */
  _relocate() {
    const pos = this.dataset.position || 'floating-bottom-right';
    if (pos !== 'header' && pos !== 'footer') return;

    const configured = (this.dataset.container || '').trim();
    let target = null;
    if (configured) {
      try { target = document.querySelector(configured); } catch (_) { target = null; }
    }
    if (!target) {
      target = document.querySelector(pos === 'header' ? 'header' : 'footer');
    }
    if (!target) {
      // No container — fall back to a floating position so the control is
      // never lost off-screen.
      this._warn(pos, 'container not found; falling back to floating');
      this.classList.remove('cp-locale-switcher--header', 'cp-locale-switcher--footer');
      this.classList.add('cp-locale-switcher--floating-bottom-right');
      return;
    }
    if (this.parentNode !== target) {
      // Moving the node preserves its own listeners; connectedCallback
      // re-entry is guarded by _initialized.
      target.appendChild(this);
      this._log('relocated into', pos, 'container');
    }
  }
}

if (!customElements.get('cp-locale-switcher')) {
  customElements.define('cp-locale-switcher', CpLocaleSwitcher);
}
