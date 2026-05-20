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
    if (this._thumbsRO) { this._thumbsRO.disconnect(); this._thumbsRO = null; }
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

    // Path C: read theme gallery settings from DOM (Dawn-compatible) so
    // thumbnail layout, position, mobile behaviour and video looping
    // follow the theme's own product-gallery settings without the
    // merchant having to mirror them in our App-Embed UI.
    this._themeSettings = this._detectThemeSettings();
    this._log('theme settings:', JSON.stringify(this._themeSettings));

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

  // Dispatcher: render any media item (image / video / external_video /
  // model) into a main-slot element. The .cp-gallery__main-image class
  // is reused for all types because the CSS layout (absolute, opacity
  // .is-active toggle) applies the same regardless of element tag.
  _mainItemHtml(item, active, index, thumbMode) {
    if (!item) return '';
    const t = item.type || 'image';
    if (t === 'image')          return this._mainImageHtml(item, active, index, thumbMode);
    if (t === 'video')          return this._mainVideoHtml(item, active, index);
    if (t === 'external_video') return this._mainExternalVideoHtml(item, active, index);
    if (t === 'model')          return this._mainModelHtml(item, active, index);
    return '';
  }

  // Render every image as an <img> in the DOM up front. Loading strategy
  // depends on layout:
  //  • Thumb mode: all main elements overlap absolutely at the same
  //    viewport position, so any of them can become active at any time.
  //    Images load eagerly so a click on a yet-unloaded thumb never
  //    reveals a blank during the opacity transition.
  //  • Stacked mode: items flow vertically, so off-screen ones safely
  //    defer via loading=lazy.
  _mainImageHtml(img, active, index, thumbMode) {
    const w = Number(img && img.w) > 0 ? Number(img.w) : 800;
    const h = Number(img && img.h) > 0 ? Number(img.h) : '';
    const isFirst = index === 0;
    // RISK-6: eager-all in thumb mode does not scale on 30+ image
    // products (LCP + bandwidth on mobile). Preload the first few
    // greedily (the user is most likely to click them next) and lazy
    // the rest; _bindThumbs awaits img.decode() before the .is-active
    // swap so a click on a yet-unloaded lazy image still never reveals
    // a blank during the opacity transition.
    const EAGER_THUMB_PRELOAD = 4;
    const loadAttrs = thumbMode
      ? (isFirst ? 'loading="eager" fetchpriority="high"'
                 : (index < EAGER_THUMB_PRELOAD ? 'loading="eager" fetchpriority="auto"'
                                               : 'loading="lazy" fetchpriority="auto"'))
      : (isFirst ? 'loading="eager" fetchpriority="high"' : 'loading="lazy" fetchpriority="auto"');
    return `<img
          class="cp-gallery__main-image${active ? ' is-active' : ''}"
          src="${img.src_800}"
          srcset="${img.src_400} 400w, ${img.src_800} 800w, ${img.src_1200} 1200w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          alt="${this._esc(img.alt)}"
          ${loadAttrs}
          decoding="async"
          data-index="${index}"
          data-type="image"
          width="${w}"${h ? ` height="${h}"` : ''}
        >`;
  }

  // Native Shopify video: HTML5 <video> with poster + controls.
  // preload=metadata is light (just dimensions / duration). No autoplay.
  // playsinline keeps iOS from going fullscreen on play.
  _mainVideoHtml(item, active, index) {
    const w = Number(item.w) > 0 ? Number(item.w) : '';
    const h = Number(item.h) > 0 ? Number(item.h) : '';
    const sources = (item.sources || [])
      .map((s) => `<source src="${this._esc(s.src)}" type="${this._esc(s.mime)}">`)
      .join('');
    // Path C: mirror Dawn's enable_video_looping section setting if the
    // theme has it on (detected via the presence of any <video loop>).
    const loopAttr = (this._themeSettings && this._themeSettings.videoLoop) ? 'loop' : '';
    return `<video
          class="cp-gallery__main-image${active ? ' is-active' : ''}"
          poster="${this._esc(item.poster)}"
          controls
          preload="metadata"
          playsinline
          ${loopAttr}
          data-index="${index}"
          data-type="video"
          ${w ? `width="${w}"` : ''}${h ? ` height="${h}"` : ''}
        >${sources}</video>`;
  }

  // YouTube/Vimeo: build embed URL by host. loading=lazy keeps the
  // iframe network cost off the critical path until activation.
  _mainExternalVideoHtml(item, active, index) {
    const w = Number(item.w) > 0 ? Number(item.w) : '';
    const h = Number(item.h) > 0 ? Number(item.h) : '';
    const host = String(item.host || '').toLowerCase();
    const xid  = encodeURIComponent(String(item.external_id || ''));
    let url = '';
    if (host === 'youtube')    url = `https://www.youtube.com/embed/${xid}?enablejsapi=1&playsinline=1&rel=0`;
    else if (host === 'vimeo') url = `https://player.vimeo.com/video/${xid}?dnt=1`;
    if (!url) return '';
    return `<iframe
          class="cp-gallery__main-image${active ? ' is-active' : ''}"
          src="${url}"
          title="${this._esc(item.alt)}"
          allow="autoplay; encrypted-media; picture-in-picture"
          allowfullscreen
          loading="lazy"
          referrerpolicy="strict-origin-when-cross-origin"
          data-index="${index}"
          data-type="external_video"
          ${w ? `width="${w}"` : ''}${h ? ` height="${h}"` : ''}
        ></iframe>`;
  }

  // 3D model via Google's <model-viewer> custom element. The library
  // is lazy-loaded once per page (see _ensureModelViewerLib). Until it
  // arrives the unknown <model-viewer> tag shows the poster image via
  // its CSS, so users never see a blank — they get a 3D-rotatable
  // preview as soon as the script lands.
  _mainModelHtml(item, active, index) {
    const w = Number(item.w) > 0 ? Number(item.w) : 800;
    const h = Number(item.h) > 0 ? Number(item.h) : 800;
    return `<model-viewer
          class="cp-gallery__main-image${active ? ' is-active' : ''}"
          src="${this._esc(item.model_src)}"
          poster="${this._esc(item.poster)}"
          alt="${this._esc(item.alt)}"
          camera-controls
          touch-action="pan-y"
          reveal="interaction"
          loading="lazy"
          data-index="${index}"
          data-type="model"
          style="aspect-ratio: ${w} / ${h};"
        ></model-viewer>`;
  }

  // Lazy-load Google's model-viewer Web Component on first 3D render.
  // RISK-1: served from the extension's own assets (Shopify CDN) rather
  // than a third-party CDN, so App Store reviewers see no external script
  // and GDPR has no extra cross-border data flow. URL is passed via the
  // data-model-viewer-src attribute (Liquid `asset_url` filter).
  // RISK-4: onerror resets the loading flag so a transient failure does
  // not permanently disable 3D for the rest of the session — the next
  // render attempt can retry.
  _ensureModelViewerLib() {
    if (window.__cpVgModelViewerLoaded || window.__cpVgModelViewerLoading) return;
    const src = this.dataset.modelViewerSrc;
    if (!src) return;
    window.__cpVgModelViewerLoading = true;
    const s = document.createElement('script');
    s.type = 'module';
    s.crossOrigin = 'anonymous';
    s.src = src;
    s.onload  = () => { window.__cpVgModelViewerLoaded = true; };
    s.onerror = () => { window.__cpVgModelViewerLoading = false; };
    document.head.appendChild(s);
  }

  // Path C: detect the host theme's product-gallery settings from the DOM
  // so our gallery can mirror them. Dawn exposes them as classes on the
  // .product wrapper and as data-attrs on <media-gallery>:
  //
  //   thumbnail_position    → <media-gallery data-thumbnail-position="…">
  //                           OR .product--thumbnails-{pos} on .product
  //   gallery_layout        → <media-gallery data-desktop-layout="…">
  //                           OR .product--{stacked|columns|thumbnail|
  //                           thumbnail_slider} on .product
  //   mobile_thumbnails     → .product--mobile-{columns|show|hide}
  //   enable_video_looping  → <video loop> present anywhere
  //
  // Non-Dawn themes that don't publish these will simply produce a null
  // result and we fall back to our own App-Embed settings — no harm.
  _detectThemeSettings() {
    if (this.dataset.inheritTheme !== '1') return null;
    const gallery = document.querySelector('media-gallery');
    const product = document.querySelector('.product');
    if (!gallery && !product) return null;
    const out = {};
    const allowed = ['bottom', 'top', 'left', 'right'];

    let tp = gallery && gallery.dataset && gallery.dataset.thumbnailPosition;
    if (!tp && product) {
      const m = product.className.match(/product--thumbnails-(bottom|top|left|right)/);
      if (m) tp = m[1];
    }
    if (allowed.indexOf(tp) >= 0) out.thumbPos = tp;

    let dl = gallery && gallery.dataset && gallery.dataset.desktopLayout;
    if (!dl && product) {
      const layouts = ['thumbnail_slider', 'thumbnail', 'columns', 'stacked'];
      for (const l of layouts) {
        if (product.classList.contains('product--' + l)) { dl = l; break; }
      }
    }
    if (dl) out.showThumbs = (dl === 'thumbnail' || dl === 'thumbnail_slider');

    if (product) {
      const m = product.className.match(/product--mobile-(columns|show|hide)/);
      if (m) out.mobileThumbs = m[1];
    }

    out.videoLoop = !!document.querySelector('video[loop]');

    // media_fit: read object-fit from a native gallery image. The native
    // gallery is in the DOM (possibly visibility:hidden via cp-vg-prehide,
    // which doesn't affect computed styles) so this is reliable. Falls
    // back to undefined when no image found → our default rules apply.
    const sampleRoot = gallery || product || document;
    const sampleImg = sampleRoot.querySelector(
      '[data-media-id] img, .product__media img, .product__media-item img'
    );
    if (sampleImg) {
      try {
        const fit = getComputedStyle(sampleImg).objectFit;
        if (fit === 'cover' || fit === 'contain') out.mediaFit = fit;
      } catch (_) { /* hidden / not paintable */ }
    }

    // image_zoom: detect via DOM markers, independent of Dawn's media-
    // gallery.js execution order (defer scripts run after us in source
    // order). We pick up either Dawn's lightbox path (<product-modal> /
    // .product__modal-opener), Dawn's hover path (image-magnify wrapper),
    // or the modified-Dawn inline-cursor signal.
    const root = gallery || product || document;
    const hasLightbox = !!document.querySelector('product-modal')
                     || !!root.querySelector('.product__modal-opener');
    const hasHover    = !!root.querySelector('image-magnify, [class*="image-magnify"]');
    let inlineCursor = false;
    if (sampleImg) {
      try { inlineCursor = (sampleImg.style.cursor === 'zoom-in'); } catch (_) {}
    }
    if (hasLightbox || hasHover || inlineCursor) out.zoom = true;

    return out;
  }

  _resolveThumbMode() {
    const theme = this._themeSettings || {};
    const show = (typeof theme.showThumbs === 'boolean')
      ? theme.showThumbs
      : (this.dataset.showThumbs === '1');
    const allowed = ['bottom', 'top', 'left', 'right'];
    let pos = theme.thumbPos || this.dataset.thumbPos;
    if (allowed.indexOf(pos) < 0) pos = 'bottom';
    return { show, pos };
  }

  _render(images) {
    const inner = this._mount.querySelector('.cp-gallery__inner');
    if (!inner) return;
    const { show, pos } = this._resolveThumbMode();
    const thumbMode = show && images.length > 1;

    // RISK-3: tear down any prior ResizeObserver on the thumb strip so
    // re-renders (e.g. variant switch) do not leak observers holding
    // refs to the now-detached old strip element.
    if (this._thumbsRO) { this._thumbsRO.disconnect(); this._thumbsRO = null; }

    // Lazy-load model-viewer once if any item is a 3D model — the
    // unknown element falls back to its poster CSS until the library
    // upgrades it, so users never see a blank.
    if (images.some((it) => it && it.type === 'model')) this._ensureModelViewerLib();

    // Reset wrapper state — class + data-attr drive all layout/CSS.
    inner.className = 'cp-gallery__inner' + (thumbMode ? '' : ' cp-gallery__inner--stacked');
    if (thumbMode) inner.setAttribute('data-thumb-pos', pos);
    else inner.removeAttribute('data-thumb-pos');
    // Path C: mirror the theme's mobile-thumbnail behaviour. CSS reads
    // this attribute to hide / show / collapse-to-columns the thumb strip
    // below the Dawn breakpoint (750px).
    const mt = this._themeSettings && this._themeSettings.mobileThumbs;
    if (mt) inner.setAttribute('data-mobile-thumbs', mt);
    else inner.removeAttribute('data-mobile-thumbs');
    // Path C: mirror the theme's media_fit (object-fit: contain / cover).
    const mf = this._themeSettings && this._themeSettings.mediaFit;
    if (mf) inner.setAttribute('data-media-fit', mf);
    else inner.removeAttribute('data-media-fit');

    if (!thumbMode) {
      // Stacked mode: one .cp-gallery__main per item (each at its own
      // natural aspect ratio), no thumbnail strip. Behaves like the
      // native theme gallery but scoped to the variant's media.
      inner.innerHTML = images.map((item, i) => `
        <div class="cp-gallery__main"${this._ratioStyle(item)}>
          ${this._mainItemHtml(item, true, i, false)}
        </div>`).join('');
      this._bindZoom(inner);
      return;
    }

    // Thumb mode: one .cp-gallery__main with ALL items stacked
    // absolutely (only one .is-active at a time) so toggling between
    // them never reloads and never flashes.
    const mainImgs = images.map((item, i) => this._mainItemHtml(item, i === 0, i, true)).join('');
    const mainHtml = `
      <div class="cp-gallery__main"${this._ratioStyle(images[0])}>
        ${mainImgs}
      </div>`;

    const thumbItems = images.map((item, i) => {
      const t = item.type || 'image';
      const overlay = (t === 'video' || t === 'external_video') ? 'play'
                    : (t === 'model') ? '3d' : '';
      return `<button
        class="cp-gallery__thumb${i === 0 ? ' is-active' : ''}"
        type="button"
        aria-label="Media ${i + 1}"
        data-index="${i}"
        data-type="${this._esc(t)}"
        data-overlay="${overlay}"
        data-w="${item.w || ''}"
        data-h="${item.h || ''}"
      >
        <img src="${item.thumb}" alt="${this._esc(item.alt)} ${i + 1}" loading="lazy" width="160" height="160">
      </button>`;
    }).join('');

    const thumbsHtml = `
      <div class="cp-gallery__thumbs-wrap">
        <button class="cp-gallery__arrow cp-gallery__arrow--prev" type="button" aria-label="Previous">‹</button>
        <div class="cp-gallery__thumbs">${thumbItems}</div>
        <button class="cp-gallery__arrow cp-gallery__arrow--next" type="button" aria-label="Next">›</button>
      </div>`;

    inner.innerHTML = mainHtml + thumbsHtml;
    this._bindThumbs(inner);
    this._bindArrows(inner);
    this._bindZoom(inner);
  }

  // Path C: click-to-scale-2x zoom on the active main image, matching
  // the modified-Dawn behaviour (theme's image_zoom is detected via DOM
  // markers in _detectThemeSettings). Bound once per <img> via a
  // data-flag so subsequent _render calls do not stack listeners.
  // Right-click / context-menu unaffected (only the default click
  // event fires this). State is kept in img.dataset so _bindThumbs can
  // reset it cross-image.
  _bindZoom(container) {
    if (!this._themeSettings || !this._themeSettings.zoom) return;
    const imgs = container.querySelectorAll('img.cp-gallery__main-image');
    imgs.forEach((img) => {
      if (img.dataset.cpZoomBound === '1') return;
      img.dataset.cpZoomBound = '1';
      img.style.cursor = 'zoom-in';
      img.addEventListener('click', (e) => {
        const zoomed = img.dataset.cpZoomed === '1';
        if (!zoomed) {
          const r = img.getBoundingClientRect();
          const x = ((e.clientX - r.left) / r.width) * 100;
          const y = ((e.clientY - r.top) / r.height) * 100;
          img.style.transformOrigin = `${x}% ${y}%`;
          img.style.transform = 'scale(2)';
          img.style.transition = 'transform 0.3s ease';
          img.style.cursor = 'zoom-out';
          img.dataset.cpZoomed = '1';
        } else {
          img.style.transform = '';
          img.style.cursor = 'zoom-in';
          img.dataset.cpZoomed = '0';
        }
      });
    });
  }

  // Reset any zoom state on the currently-active image. Called from
  // _bindThumbs on thumb click so switching items never leaves the
  // outgoing image stuck mid-zoom when the shopper returns to it.
  _resetZoomOn(el) {
    if (el && el.dataset && el.dataset.cpZoomed === '1') {
      el.style.transform = '';
      el.style.cursor = 'zoom-in';
      el.dataset.cpZoomed = '0';
    }
  }

  // Pause whatever is currently playing before switching items so a
  // hidden iframe / video does not keep audio running off-screen.
  // <video>: .pause(). <iframe>: postMessage to YT/Vimeo APIs (cheap,
  // graceful — if the message is unrecognised the player just ignores
  // it). <model-viewer>: nothing to pause.
  _pauseMedia(el) {
    if (!el) return;
    if (el.tagName === 'VIDEO') {
      try { el.pause(); } catch (_) {}
      return;
    }
    if (el.tagName === 'IFRAME') {
      try {
        const win = el.contentWindow;
        if (!win) return;
        const src = el.getAttribute('src') || '';
        // RISK-2: explicit target origin — never use '*'. Both player
        // origins are fixed (we built the embed URL ourselves), so we
        // can be precise. App-Store-scanners flag '*' as anti-pattern.
        if (src.indexOf('youtube.com') >= 0) {
          win.postMessage('{"event":"command","func":"pauseVideo","args":""}', 'https://www.youtube.com');
        } else if (src.indexOf('vimeo.com') >= 0) {
          win.postMessage('{"method":"pause"}', 'https://player.vimeo.com');
        }
      } catch (_) { /* cross-origin, ignore */ }
    }
  }

  _bindThumbs(container) {
    const mains = Array.from(container.querySelectorAll('.cp-gallery__main-image'));
    const thumbs = Array.from(container.querySelectorAll('.cp-gallery__thumb'));
    const mainBox = container.querySelector('.cp-gallery__main');
    // RISK-6: a click sequence guards against the race where the user
    // taps multiple thumbs quickly. Only the most recent click is
    // allowed to commit its .is-active swap after its image decode.
    let clickSeq = 0;
    thumbs.forEach((thumb) => {
      thumb.addEventListener('click', async () => {
        const seq = ++clickSeq;
        const i = Number(thumb.dataset.index);
        const w = Number(thumb.dataset.w), h = Number(thumb.dataset.h);
        if (mainBox && w > 0 && h > 0) mainBox.style.aspectRatio = `${w} / ${h}`;
        // Pause the outgoing item BEFORE awaiting decode so audio does
        // not keep playing while the next image is being decoded. Also
        // reset any zoom state on the outgoing image (Path C image_zoom).
        const outgoing = container.querySelector('.cp-gallery__main-image.is-active');
        this._pauseMedia(outgoing);
        this._resetZoomOn(outgoing);
        // RISK-6: preload the target image fully before the opacity
        // swap so a not-yet-loaded lazy image never reveals a blank
        // during the .is-active transition. <video> / <iframe> /
        // <model-viewer> don't implement decode() — skip silently.
        const target = mains[i];
        if (target && typeof target.decode === 'function') {
          try { await target.decode(); } catch (_) { /* loaded enough */ }
        }
        if (seq !== clickSeq) return; // a newer click superseded this one
        mains.forEach((m, j) => m.classList.toggle('is-active', j === i));
        thumbs.forEach((t, j) => t.classList.toggle('is-active', j === i));
        // Keep the active thumb visible in the carousel.
        thumb.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
      });
    });
  }

  _bindArrows(container) {
    const wrap = container.querySelector('.cp-gallery__thumbs-wrap');
    if (!wrap) return;
    const strip = wrap.querySelector('.cp-gallery__thumbs');
    const prev = wrap.querySelector('.cp-gallery__arrow--prev');
    const next = wrap.querySelector('.cp-gallery__arrow--next');
    if (!strip || !prev || !next) return;
    const vertical = container.dataset.thumbPos === 'left' || container.dataset.thumbPos === 'right';
    const stepBy = (dir) => {
      const step = (vertical ? strip.clientHeight : strip.clientWidth) * 0.8;
      strip.scrollBy(vertical ? { top: dir * step, behavior: 'smooth' } : { left: dir * step, behavior: 'smooth' });
    };
    prev.addEventListener('click', () => stepBy(-1));
    next.addEventListener('click', () => stepBy(1));
    const updateState = () => {
      const max = vertical ? strip.scrollHeight - strip.clientHeight : strip.scrollWidth - strip.clientWidth;
      const cur = vertical ? strip.scrollTop : strip.scrollLeft;
      // Hide arrows entirely when the strip does not overflow.
      const overflow = max > 1;
      wrap.classList.toggle('cp-gallery__thumbs-wrap--scrollable', overflow);
      prev.toggleAttribute('disabled', !overflow || cur <= 0);
      next.toggleAttribute('disabled', !overflow || cur >= max - 1);
    };
    strip.addEventListener('scroll', updateState, { passive: true });
    // RISK-3: react to viewport resize / mobile rotation / theme CSS
    // changes that flip overflow ON or OFF, so the arrow-visibility and
    // disabled state stay correct without a re-render.
    if (typeof ResizeObserver === 'function') {
      this._thumbsRO = new ResizeObserver(updateState);
      this._thumbsRO.observe(strip);
    }
    // Defer to next frame so layout (esp. vertical heights) is final.
    requestAnimationFrame(updateState);
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
