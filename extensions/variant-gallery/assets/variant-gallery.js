/*
 * App Block controller. The block lives inside the product section, so on
 * themes that re-render the section via the Section Rendering API a fresh
 * instance is created on every variant change. Each instance binds its own
 * listeners/observer and tears them down in disconnectedCallback so the
 * removed instances don't leak.
 */
class CpVariantGallery extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;
    this._debug = this.dataset.debug === '1';
    this._log('connected. block:', this.dataset.blockId, 'initial variant:', this.dataset.currentVariant);

    this._data      = this._loadData();
    this._mainImg   = this.querySelector('.cp-gallery__main-image');
    this._currentId = this.dataset.currentVariant ? String(this.dataset.currentVariant) : null;

    this._onVariantEvent = (e) => {
      const id = e.detail && e.detail.variant && e.detail.variant.id;
      if (id) this._switchVariant(id);
    };
    this._onMaybeChanged = () => this._onVariantMaybeChanged();
    this._onChange = (e) => {
      if (e.target && e.target.matches && e.target.matches('[name="id"]')) this._onVariantMaybeChanged();
    };

    this._bindThumbs();
    this._watchVariant();
  }

  disconnectedCallback() {
    if (this._mo) { this._mo.disconnect(); this._mo = null; }
    document.removeEventListener('variant:change', this._onVariantEvent);
    document.removeEventListener('variant_change', this._onMaybeChanged);
    document.removeEventListener('change', this._onChange, true);
    window.removeEventListener('popstate', this._onMaybeChanged);
    if (this._input) this._input.removeEventListener('input', this._onMaybeChanged);
  }

  _log(...args) { if (this._debug) console.info('[cp-variant-gallery]', ...args); }
  _warn(...args) { if (this._debug) console.warn('[cp-variant-gallery]', ...args); }

  _loadData() {
    const el = document.getElementById('cp-gallery-data-' + this.dataset.blockId);
    if (!el) { this._warn('data <script> not found for block', this.dataset.blockId); return {}; }
    try {
      const parsed = JSON.parse(el.textContent);
      this._log('data parsed. variant ids:', Object.keys(parsed));
      return parsed;
    } catch (err) {
      console.error('[cp-variant-gallery] JSON parse failed:', err);
      return {};
    }
  }

  /* ---------- variant detection (theme-agnostic) ---------- */

  _watchVariant() {
    document.addEventListener('variant:change', this._onVariantEvent);
    document.addEventListener('variant_change', this._onMaybeChanged);
    document.addEventListener('change', this._onChange, true);
    window.addEventListener('popstate', this._onMaybeChanged);

    const input = this._variantInput();
    if (input && 'MutationObserver' in window) {
      this._input = input;
      this._mo = new MutationObserver(this._onMaybeChanged);
      this._mo.observe(input, { attributes: true, attributeFilter: ['value'] });
      input.addEventListener('input', this._onMaybeChanged);
    }
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
    if (id && id !== this._currentId) {
      this._log('variant change:', this._currentId, '->', id);
      this._switchVariant(id);
    }
  }

  /* ---------- rendering ---------- */

  _bindThumbs() {
    this.querySelectorAll('.cp-gallery__thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => this._activateThumb(thumb));
    });
  }

  _activateThumb(thumb) {
    if (!this._mainImg) return;
    const mainBox = this.querySelector('.cp-gallery__main');
    const w = Number(thumb.dataset.w), h = Number(thumb.dataset.h);
    if (mainBox && w > 0 && h > 0) mainBox.style.aspectRatio = `${w} / ${h}`;
    this._mainImg.src    = thumb.dataset.srcMd;
    this._mainImg.srcset = [
      thumb.dataset.srcSm + ' 400w',
      thumb.dataset.srcMd + ' 800w',
      thumb.dataset.srcLg + ' 1200w',
    ].join(', ');
    this.querySelectorAll('.cp-gallery__thumb').forEach((t) => t.classList.remove('is-active'));
    thumb.classList.add('is-active');
  }

  _switchVariant(variantId) {
    const id = String(variantId);
    this._currentId = id;
    const images = this._data[id];
    const inner  = this.querySelector('.cp-gallery__inner');
    if (!inner) { this._warn('no .cp-gallery__inner'); return; }

    if (!images || images.length === 0) {
      this._log('no images for variant', id, '— clearing custom gallery');
      inner.innerHTML = '';
      return;
    }
    this._log('rendering', images.length, 'image(s) for variant', id);

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

    inner.innerHTML = mainHtml + thumbsHtml;
    this._mainImg = this.querySelector('.cp-gallery__main-image');
    this._bindThumbs();
  }

  // Reserve the box BEFORE the image loads so thumbnails never jump.
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

  _esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('cp-variant-gallery')) {
  customElements.define('cp-variant-gallery', CpVariantGallery);
}
