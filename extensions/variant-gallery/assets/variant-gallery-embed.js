/*
 * App Embed controller. The custom element stays where Shopify injects it
 * (in <body>, outside the product section) so it survives Section Rendering
 * API re-renders. The visible gallery is a separate "mount" node we keep
 * placed right before the theme's native gallery. Everything is resolved
 * fresh on every tick so it stays correct after AJAX variant changes that
 * replace the product section.
 */
class CpEmbedGallery extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    // Debug switch is intentionally NOT a merchant-facing schema setting
    // (would be exposed to every store owner in production). Devs enable
    // it ad-hoc by appending ?cp_debug=1 to the product URL.
    this._debug = (() => {
      try { return new URL(location.href).searchParams.has('cp_debug'); }
      catch (_) { return false; }
    })();
    this._log('connected. block:', this.dataset.blockId);

    this._onTick = this._tick.bind(this);
    // NOTE-2: gate _preCover via _needsCover() like the other paths, so a
    // popstate / variant_change that does not actually change our product
    // does not blink the gallery.
    this._onTickRaw = () => { if (this._needsCover()) this._preCover(); this._schedule(); };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init(), { once: true });
    } else {
      this._init();
    }
  }

  disconnectedCallback() {
    // The controller lives in <body> and is normally never removed; clean up
    // defensively anyway so we never leak observers/listeners.
    if (this._bodyMo) { this._bodyMo.disconnect(); this._bodyMo = null; }
    clearTimeout(this._t);
    // NOTE-3: also drop any pending fail-safe timers we registered on the
    // shared registry so a disconnect can never leave one to fire later.
    if (window.__cpVgFouc) {
      clearTimeout(window.__cpVgFouc.timer);
      clearTimeout(window.__cpVgFouc.prehideTimer);
    }
    document.removeEventListener('change', this._onChange, true);
    document.removeEventListener('variant:change', this._onVariantEvent);
    document.removeEventListener('variant_change', this._onTickRaw);
    window.removeEventListener('popstate', this._onTickRaw);
  }

  _log(...args) { if (this._debug) console.info('[cp-embed-gallery]', ...args); }
  _warn(...args) { if (this._debug) console.warn('[cp-embed-gallery]', ...args); }

  _init() {
    this._data = this._loadData();
    if (!this._data) { this._warn('no/invalid variant data — aborting'); return; }

    const configured = this.dataset.nativeSelector && this.dataset.nativeSelector.trim();
    // Default list kept in sync with the blanket <style> in
    // variant-gallery-prehead.liquid (canonical) and the dormant copy in
    // variant-gallery-embed.liquid. Change all three together.
    this._selectors = [
      configured,
      'media-gallery',
      '[id^="MediaGallery"]',
      '.product__media-wrapper',
      '.product__media-list',
    ].filter(Boolean);

    const scope = this.dataset.scopeSelector && this.dataset.scopeSelector.trim();
    this._scopeSelector = scope || null;

    this._state = { id: null, mode: null }; // mode: 'custom' | 'native'

    this._log('init. variant ids:', JSON.stringify(Object.keys(this._data)),
      '| selectors:', JSON.stringify(this._selectors),
      this._scopeSelector ? '| scope: ' + JSON.stringify(this._scopeSelector) : '');

    // Variant-change + section-re-render signals (all delegated/global so they
    // survive section replacement).
    // RISK-1: change/variant:change are document-wide. A foreign product
    // form (quick-view, "recommended products" with a variant selector)
    // must NOT trigger the global blanket and blink the main gallery.
    // Gate _preCover on data membership: a variant id that belongs to a
    // DIFFERENT product is not in this._data, so the cover only fires for
    // a genuine switch of the product this controller manages. _schedule()
    // stays unconditional (a foreign change just resolves to an upToDate
    // no-op tick — harmless, preserves prior behaviour).
    this._onChange = (e) => {
      if (e.target && e.target.matches && e.target.matches('[name="id"]')) {
        if (this._data && this._data[String(e.target.value)]) this._preCover();
        this._schedule();
      }
    };
    this._onVariantEvent = (e) => {
      const id = e.detail && e.detail.variant && e.detail.variant.id;
      if (id) {
        this._wantId = String(id);
        if (this._data && this._data[String(id)]) this._preCover();
        this._schedule();
      }
    };
    document.addEventListener('change', this._onChange, true);
    document.addEventListener('variant:change', this._onVariantEvent);
    document.addEventListener('variant_change', this._onTickRaw);
    window.addEventListener('popstate', this._onTickRaw);

    // Catches deferred-loaded galleries AND section re-renders on variant
    // change. When a native gallery node is actually (re)inserted/removed
    // — the theme's async Section-Rendering replacement, which fires LONG
    // after the variant-change event and after _tick already released the
    // blanket — re-cover synchronously. This observer callback runs as a
    // microtask BEFORE paint, so the freshly injected native gallery is
    // hidden before it can flash, on ANY theme regardless of which events
    // it fires. _mutationTouchesNative excludes our own mount to avoid a
    // render→observe→cover→render self-trigger loop.
    //
    // RISK-A/RISK-B: _mutationTouchesNative is product-agnostic (any
    // gallery node added/removed anywhere — e.g. a foreign quick-view —
    // would otherwise blink the main gallery and silently defeat the
    // RISK-1 gating). _needsCover() runs FIRST: it is true only when the
    // resolved variant differs from the settled state (a genuine main
    // switch). A foreign quick-view does not change our scoped [name=id],
    // so it is false → no blink, and the cheaper check short-circuits the
    // O(records·nodes·selectors) scan on the common unrelated-mutation
    // path (RISK-B mitigation).
    this._bodyMo = new MutationObserver((muts) => {
      if (this._needsCover() && this._mutationTouchesNative(muts)) this._preCover();
      this._schedule();
    });
    this._bodyMo.observe(document.body, { childList: true, subtree: true });

    this._tick();
  }

  _loadData() {
    const el = document.getElementById('cp-embed-data-' + this.dataset.blockId);
    if (!el) { this._warn('data <script> not found for block', this.dataset.blockId); return null; }
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error('[cp-embed-gallery] JSON parse failed:', err);
      return null;
    }
  }

  /* ---------- variant id resolution ---------- */

  _scopeRoot() {
    if (!this._scopeSelector) return document;
    try { return document.querySelector(this._scopeSelector) || document; } catch (_) { return document; }
  }

  _resolveVariantId() {
    // Live input wins; _wantId is only a one-shot hint for themes that fire
    // variant:change before/without updating [name="id"]. It is cleared once
    // a tick consumes it so it can never pin a stale variant.
    const input = this._scopeRoot().querySelector('[name="id"]');
    if (input && input.value) return String(input.value);
    if (this._wantId && this._data[this._wantId]) return this._wantId;
    try {
      const v = new URL(window.location.href).searchParams.get('variant');
      if (v) return String(v);
    } catch (_) { /* noop */ }
    return null;
  }

  /* ---------- native gallery ---------- */

  _queryNative() {
    const root = this._scopeRoot();
    for (const sel of this._selectors) {
      let el = null;
      try { el = root.querySelector(sel); } catch (_) { /* invalid selector */ }
      if (el && el !== this._mount && !(this._mount && this._mount.contains(el))) return el;
    }
    return null;
  }

  _extraEls() {
    const sel = (this.dataset.extraHide || '').trim();
    if (!sel) return [];
    try { return Array.from(this._scopeRoot().querySelectorAll(sel)); } catch (_) { return []; }
  }

  _hideNative(native) {
    // `.cp-vg-native-hidden` is the same class the synchronous inline
    // bootstrap (FOUC fix) sets pre-paint; keep it in sync here so the
    // element-scoped CSS rule and the inline style agree.
    native.setAttribute('hidden', '');
    native.style.display = 'none';
    native.classList.add('cp-vg-native-hidden');
    this._extraEls().forEach((el) => {
      el.setAttribute('hidden', ''); el.style.display = 'none';
      el.classList.add('cp-vg-native-hidden');
    });
  }

  _showNative(native) {
    if (native) {
      native.removeAttribute('hidden'); native.style.display = '';
      native.classList.remove('cp-vg-native-hidden');
    }
    this._extraEls().forEach((el) => {
      el.removeAttribute('hidden'); el.style.display = '';
      el.classList.remove('cp-vg-native-hidden');
    });
  }

  _ensureMount(native) {
    if (!this._mount || !this._mount.isConnected) {
      this._mount = document.createElement('div');
      this._mount.className = 'cp-embed-gallery';
      const size = parseInt(this.dataset.thumbSize, 10);
      if (size > 0) this._mount.style.setProperty('--cp-thumb-size', size + 'px');
      this._mount.innerHTML = '<div class="cp-gallery__inner"></div>';
      this._mountRendered = null;
    }
    // Keep it directly before the (possibly re-rendered) native gallery.
    if (this._mount.nextElementSibling !== native || this._mount.parentNode !== native.parentNode) {
      native.parentNode.insertBefore(this._mount, native);
    }
  }

  _removeMount() {
    if (this._mount && this._mount.isConnected) this._mount.remove();
    this._mountRendered = null;
  }

  /* ---------- tick (idempotent) ---------- */

  // True only when the resolved variant differs from the settled state —
  // i.e. a genuine switch of the product this controller manages. A
  // foreign quick-view / unrelated mutation does not change our scoped
  // [name="id"] (resolved === state.id) → false → no blanket blink. When
  // the id cannot be resolved we deliberately do NOT cover (avoids a
  // global hide on every unrelated mutation in themes without [name=id];
  // initial-load FOUC is already owned by the head block + bootstrap).
  _needsCover() {
    if (!this._data || !Object.keys(this._data).length) return false;
    const id = this._resolveVariantId();
    return id != null && (!this._state || id !== this._state.id);
  }

  // True only when a mutation actually adds/removes a native-gallery
  // element (the theme's section replacement), NOT for our own mount /
  // custom-gallery churn (excluded, else render→observe→cover→render
  // loops) nor for unrelated DOM noise (so the blanket is not toggled on
  // every mutation — that was the reason the observer path must be
  // selective rather than always pre-covering).
  _mutationTouchesNative(mutations) {
    for (const m of mutations) {
      const nodes = [];
      if (m.addedNodes) m.addedNodes.forEach((n) => nodes.push(n));
      if (m.removedNodes) m.removedNodes.forEach((n) => nodes.push(n));
      for (const n of nodes) {
        if (!n || n.nodeType !== 1) continue; // elements only
        if (this._mount &&
            (n === this._mount || this._mount.contains(n) || n.contains(this._mount))) {
          continue; // our own mount/render churn
        }
        for (const sel of this._selectors) {
          try {
            if ((n.matches && n.matches(sel)) ||
                (n.querySelector && n.querySelector(sel))) {
              return true;
            }
          } catch (_) { /* invalid selector */ }
        }
      }
    }
    return false;
  }

  // Cover the section-re-render gap on a variant change. The theme
  // replaces the product section with a fresh, VISIBLE native gallery
  // ~80ms before the debounced _tick can hide it per-element — that gap
  // is the variant-switch flash. Re-applying the global blanket class
  // synchronously here (the blanket <style> is shipped dormant by the
  // body embed, so it works even if the target:head block is disabled)
  // hides the incoming native gallery the instant it is injected. _tick
  // releases the blanket again right after it has applied the precise
  // per-element hide (same synchronous tick, no repaint in between), so
  // quick-view / other galleries are only covered for that brief gap.
  // A re-armed 3s fail-safe drops the blanket if a tick never resolves
  // (e.g. the re-rendered native never appears) so nothing gets stuck.
  //
  // Known residuals (accepted; inherent to a <html>-level global blanket):
  //  • Container-scoping the blanket instead of <html> would avoid
  //    collateral on other default-selector galleries (related /
  //    recently-viewed), but is incompatible with the target:head
  //    pre-paint path — at <head> parse time the product container does
  //    not exist yet, so the head block MUST key on <html>. The CSS is
  //    shared, so this stays <html>-level. Net effect: a genuine
  //    main-product switch briefly (~80ms+) visibility:hides such other
  //    galleries too; layout is reserved, self-healing, no shift. A
  //    FOREIGN quick-view does NOT blink them: the observer cover is
  //    gated by _needsCover() (RISK-A), which is false when our scoped
  //    variant did not change.
  //  • A theme that replaces the gallery WITHOUT first updating
  //    [name="id"]/?variant= (so _needsCover() stays false) and without
  //    firing change/variant:change/variant_change/popstate is not
  //    pre-covered (the observer must stay selective to avoid blinking on
  //    unrelated mutations). Dawn and common themes update [name="id"]
  //    before the async media replace, so the common case is covered.
  _preCover() {
    if (!this._data || !Object.keys(this._data).length) return;
    document.documentElement.classList.add('cp-vg-prehide');
    window.__cpVgFouc = window.__cpVgFouc || {};
    clearTimeout(window.__cpVgFouc.prehideTimer);
    window.__cpVgFouc.prehideTimer = setTimeout(() => {
      document.documentElement.classList.remove('cp-vg-prehide');
    }, 3000);
  }

  _schedule() {
    clearTimeout(this._t);
    this._t = setTimeout(this._onTick, 80);
  }

  _tick() {
    if (!this._data) return;
    const id = this._resolveVariantId();
    const images = id ? this._data[id] : null;
    const hasImages = Array.isArray(images) && images.length > 0;
    const native = this._queryNative();

    if (!native) {
      // Gallery not in the DOM yet (deferred) — the observer will call us
      // again; keep _wantId so the hint survives until we can act on it.
      return;
    }
    // Consumed: from here on the live input/URL is authoritative again.
    this._wantId = null;

    // The controller is now authoritative for native visibility, so cancel
    // the inline bootstrap's fail-safe (it would otherwise strip the
    // FOUC-hide class on a slow/deferred mount and flash the native gallery).
    if (window.__cpVgFouc && window.__cpVgFouc.timer) {
      clearTimeout(window.__cpVgFouc.timer);
      window.__cpVgFouc.timer = null;
    }
    // Symmetrically cancel the prehide blanket timer: the controller
    // releases the blanket itself just below, so the standalone 3s timer
    // is now redundant and must not fire spuriously later.
    if (window.__cpVgFouc && window.__cpVgFouc.prehideTimer) {
      clearTimeout(window.__cpVgFouc.prehideTimer);
      window.__cpVgFouc.prehideTimer = null;
    }

    // Defensive release of the prehide blanket: normally the per-element
    // bootstrap's finally already dropped it, but if that script was
    // blocked and only the controller loaded, this guarantees the page is
    // never left with the native gallery globally hidden. Synchronous: for
    // an image variant _hideNative runs later in this same tick, so the
    // specific element never repaints visible between here and there.
    document.documentElement.classList.remove('cp-vg-prehide');

    if (!hasImages) {
      // No metafield images for this variant → make sure native is visible.
      const alreadyNative =
        this._state.mode === 'native' &&
        (!this._mount || !this._mount.isConnected) &&
        native.style.display !== 'none';
      if (alreadyNative) return;
      this._log('variant', id, '— no images, restoring native gallery');
      this._removeMount();
      this._showNative(native);
      // Safety net for R-c: if the inline bootstrap resolved a *different*
      // native element than this controller (theme re-render between parse
      // and boot), that element would stay stuck-hidden. On a no-images
      // variant nothing of ours may be hidden, so sweep the whole document.
      document.querySelectorAll('.cp-vg-native-hidden')
        .forEach((e) => e.classList.remove('cp-vg-native-hidden'));
      this._renderFailedId = null;
      this._state = { id, mode: 'native' };
      return;
    }

    // R-b': a persistently throwing render must degrade ONCE, not every
    // tick. Without this the post-catch state (mode 'native') never
    // satisfies the 'custom' upToDate guard below, so each MutationObserver
    // tick re-enters the try, throws, and its own DOM writes re-arm the
    // observer → ~80ms busy-loop + console spam. Cleared on success and on
    // any no-images tick so a later variant change retries normally.
    if (this._renderFailedId === id) return;

    // Has images → custom gallery in place, native hidden.
    const upToDate =
      this._state.id === id &&
      this._state.mode === 'custom' &&
      this._mount && this._mount.isConnected &&
      this._mount.nextElementSibling === native &&
      native.style.display === 'none' &&
      this._mountRendered === id;
    if (upToDate) return;

    this._log('variant', id, '—', images.length, 'image(s); placing custom gallery');
    // R-b: the fail-safe is already cancelled above, so a throw in
    // _ensureMount/_hideNative/_render would otherwise leave the native
    // gallery hidden with an empty mount — permanent content loss, worse
    // than the original flash. Degrade to the (visible) native gallery.
    try {
      this._ensureMount(native);
      this._hideNative(native);
      if (this._mountRendered !== id) {
        this._render(images);
        this._mountRendered = id;
      }
      this._renderFailedId = null;
      this._state = { id, mode: 'custom' };
    } catch (err) {
      console.error('[cp-embed-gallery] custom gallery render failed, restoring native:', err);
      this._removeMount();
      this._showNative(native);
      document.querySelectorAll('.cp-vg-native-hidden')
        .forEach((e) => e.classList.remove('cp-vg-native-hidden'));
      this._renderFailedId = id;
      this._state = { id, mode: 'native' };
    }
  }

  /* ---------- rendering ---------- */

  _ratioStyle(img) {
    const w = Number(img && img.w), h = Number(img && img.h);
    return (w > 0 && h > 0) ? ` style="aspect-ratio: ${w} / ${h};"` : '';
  }

  _mainImgHtml(img) {
    const w = Number(img && img.w) > 0 ? Number(img.w) : 800;
    const h = Number(img && img.h) > 0 ? Number(img.h) : '';
    return `<img
          class="cp-gallery__main-image"
          src="${img.src_800}"
          srcset="${img.src_400} 400w, ${img.src_800} 800w, ${img.src_1200} 1200w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          alt="${this._esc(img.alt)}"
          loading="eager"
          width="${w}"${h ? ` height="${h}"` : ''}
        >`;
  }

  _render(images) {
    const first = images[0];
    const mainHtml = `
      <div class="cp-gallery__main"${this._ratioStyle(first)}>
        ${this._mainImgHtml(first)}
      </div>`;

    let thumbsHtml = '';
    if (images.length > 1) {
      const items = images.map((img, i) => `
        <button
          class="cp-gallery__thumb${i === 0 ? ' is-active' : ''}"
          type="button"
          aria-label="Image ${i + 1}"
          data-src-sm="${img.src_400}"
          data-src-md="${img.src_800}"
          data-src-lg="${img.src_1200}"
          data-w="${img.w || ''}"
          data-h="${img.h || ''}"
        >
          <img src="${img.thumb}" alt="${this._esc(img.alt)} ${i + 1}" loading="lazy" width="160" height="160">
        </button>`).join('');
      thumbsHtml = `<div class="cp-gallery__thumbs">${items}</div>`;
    }

    const inner = this._mount.querySelector('.cp-gallery__inner');
    if (inner) {
      inner.innerHTML = mainHtml + thumbsHtml;
      this._bindThumbs(inner);
    }
  }

  _bindThumbs(container) {
    container.querySelectorAll('.cp-gallery__thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        const mainImg = this._mount.querySelector('.cp-gallery__main-image');
        if (!mainImg) return;
        const mainBox = this._mount.querySelector('.cp-gallery__main');
        const w = Number(thumb.dataset.w), h = Number(thumb.dataset.h);
        if (mainBox && w > 0 && h > 0) mainBox.style.aspectRatio = `${w} / ${h}`;
        mainImg.src    = thumb.dataset.srcMd;
        mainImg.srcset = `${thumb.dataset.srcSm} 400w, ${thumb.dataset.srcMd} 800w, ${thumb.dataset.srcLg} 1200w`;
        container.querySelectorAll('.cp-gallery__thumb').forEach((t) => t.classList.remove('is-active'));
        thumb.classList.add('is-active');
      });
    });
  }

  _esc(str) {
    // Escape for both HTML attribute and element context. `&` MUST be first.
    // Escaping only & and " left `<`/`>` open: a variant title like
    // `</img><img src=x onerror=...>` (merchant/CSV/personalization-app
    // influenced) executed in every shopper's browser on variant re-render
    // (stored XSS). Inject only via this for any untrusted string.
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}

if (!customElements.get('cp-embed-gallery')) {
  customElements.define('cp-embed-gallery', CpEmbedGallery);
}
