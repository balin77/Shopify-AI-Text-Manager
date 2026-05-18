const CP_LOG = '[cp-embed-gallery]';

class CpEmbedGallery extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    console.info(CP_LOG, 'connected. block:', this.dataset.blockId);

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init());
    } else {
      this._init();
    }
  }

  _init() {
    this._data      = this._loadData();
    this._currentId = null;

    // Build the selector list: the merchant-configured one first, then
    // robust Dawn-compatible fallbacks.
    const configured = this.dataset.nativeSelector && this.dataset.nativeSelector.trim();
    this._selectors = [
      configured,
      'media-gallery',
      '[id^="MediaGallery"]',
      '.product__media-wrapper',
      '.product__media-list',
    ].filter(Boolean);

    console.info(CP_LOG, 'init. data:', !!this._data,
      this._data ? 'variant ids: ' + JSON.stringify(Object.keys(this._data)) : '',
      '| trying selectors:', JSON.stringify(this._selectors));

    if (!this._data) { console.warn(CP_LOG, 'no/invalid variant data — aborting'); return; }

    // The native gallery may be deferred-loaded (this theme uses deferred
    // loading), so it might not be in the DOM yet. Wait for it instead of
    // giving up after one query.
    this._whenNativeGallery((gallery) => {
      this._nativeGallery = gallery;
      console.info(CP_LOG, 'native gallery found:', gallery.tagName,
        gallery.id ? '#' + gallery.id : '', gallery.className ? '.' + gallery.className.split(' ')[0] : '');

      gallery.parentNode.insertBefore(this, gallery);

      const initialId = this._resolveVariantId();
      console.info(CP_LOG, 'initial variant id resolved:', initialId);
      if (initialId) this._switchVariant(initialId);

      this._watchVariant();
    });
  }

  _queryNative() {
    for (const sel of this._selectors) {
      let el = null;
      try { el = document.querySelector(sel); } catch (_) { /* invalid selector */ }
      if (el) return el;
    }
    return null;
  }

  _whenNativeGallery(cb) {
    const found = this._queryNative();
    if (found) { cb(found); return; }

    let settled = false;
    const finish = (el) => {
      if (settled) return;
      settled = true;
      if (this._mo) { this._mo.disconnect(); this._mo = null; }
      clearTimeout(this._to);
      if (el) cb(el);
    };

    // Watch the DOM until the deferred-loaded gallery appears.
    this._mo = new MutationObserver(() => {
      const el = this._queryNative();
      if (el) finish(el);
    });
    this._mo.observe(document.documentElement, { childList: true, subtree: true });

    // Give up after 10s so we never observe forever.
    this._to = setTimeout(() => {
      if (settled) return;
      console.warn(CP_LOG, 'native gallery NOT found after 10s with selectors',
        JSON.stringify(this._selectors),
        '— inspect the product gallery element and set its selector in the app embed settings.');
      finish(null);
    }, 10000);
  }

  _loadData() {
    const el = document.getElementById('cp-embed-data-' + this.dataset.blockId);
    if (!el) { console.warn(CP_LOG, 'data <script> not found for block', this.dataset.blockId); return null; }
    try {
      return JSON.parse(el.textContent);
    } catch (err) {
      console.error(CP_LOG, 'JSON parse failed:', err, '\nraw:', el.textContent);
      return null;
    }
  }

  /* ---------- variant detection (theme-agnostic) ---------- */

  _watchVariant() {
    const handler = () => this._onVariantMaybeChanged();

    document.addEventListener('variant:change', (e) => {
      const id = e.detail && e.detail.variant && e.detail.variant.id;
      if (id) this._switchVariant(id);
    });
    document.addEventListener('variant_change', handler);

    document.addEventListener('change', (e) => {
      if (e.target && e.target.matches && e.target.matches('[name="id"]')) handler();
    });

    // Modern Dawn sets input[name="id"].value programmatically (no change event)
    // and updates the URL — observe both.
    const input = this._variantInput();
    if (input && 'MutationObserver' in window) {
      this._mo = new MutationObserver(handler);
      this._mo.observe(input, { attributes: true, attributeFilter: ['value'] });
      input.addEventListener('input', handler);
    }
    window.addEventListener('popstate', handler);
  }

  _variantInput() {
    return document.querySelector('[name="id"]');
  }

  _resolveVariantId() {
    const input = this._variantInput();
    if (input && input.value) return String(input.value);
    try {
      const v = new URL(window.location.href).searchParams.get('variant');
      if (v) return String(v);
    } catch (_) { /* noop */ }
    return null;
  }

  _onVariantMaybeChanged() {
    const id = this._resolveVariantId();
    if (id && id !== this._currentId) this._switchVariant(id);
  }

  /* ---------- native gallery show / hide ---------- */

  _extraEls() {
    const sel = (this.dataset.extraHide || '').trim();
    if (!sel) return [];
    try { return Array.from(document.querySelectorAll(sel)); } catch (_) { return []; }
  }

  _hideNative() {
    if (!this._nativeGallery) return;
    this._nativeGallery.setAttribute('hidden', '');
    this._nativeGallery.style.display = 'none';
    this._extraEls().forEach((el) => { el.setAttribute('hidden', ''); el.style.display = 'none'; });
  }

  _showNative() {
    if (!this._nativeGallery) return;
    this._nativeGallery.removeAttribute('hidden');
    this._nativeGallery.style.display = '';
    this._extraEls().forEach((el) => { el.removeAttribute('hidden'); el.style.display = ''; });
  }

  /* ---------- rendering ---------- */

  _switchVariant(variantId) {
    const id = String(variantId);
    this._currentId = id;
    const images = this._data[id];

    if (!images || images.length === 0) {
      // No variant gallery for this variant — restore native gallery.
      console.info(CP_LOG, 'variant', id, 'has NO metafield images — restoring native gallery (this is why all images show: the metafield is empty for this variant or the id key does not match).');
      this.style.display = 'none';
      this._showNative();
      return;
    }

    // Has variant gallery — hide native, render ours.
    console.info(CP_LOG, 'variant', id, 'has', images.length, 'metafield image(s) — hiding native, rendering custom gallery.');
    this._hideNative();
    this.style.display = 'block';
    this._render(images);
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

    const inner = this.querySelector('.cp-gallery__inner');
    if (inner) {
      inner.innerHTML = mainHtml + thumbsHtml;
      this._bindThumbs(inner);
    }
  }

  _bindThumbs(container) {
    container.querySelectorAll('.cp-gallery__thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => {
        const mainImg = this.querySelector('.cp-gallery__main-image');
        if (!mainImg) return;
        const mainBox = this.querySelector('.cp-gallery__main');
        const w = Number(thumb.dataset.w), h = Number(thumb.dataset.h);
        if (mainBox && w > 0 && h > 0) mainBox.style.aspectRatio = `${w} / ${h}`;
        mainImg.src    = thumb.dataset.srcMd;
        mainImg.srcset = `${thumb.dataset.srcSm} 400w, ${thumb.dataset.srcMd} 800w, ${thumb.dataset.srcLg} 1200w`;
        container.querySelectorAll('.cp-gallery__thumb').forEach((t) => t.classList.remove('is-active'));
        thumb.classList.add('is-active');
      });
    });
  }

  // Reserve the box BEFORE the image loads so thumbnails never jump.
  _ratioStyle(img) {
    const w = Number(img && img.w);
    const h = Number(img && img.h);
    if (w > 0 && h > 0) return ` style="aspect-ratio: ${w} / ${h};"`;
    return '';
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

  _esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('cp-embed-gallery')) {
  customElements.define('cp-embed-gallery', CpEmbedGallery);
}
