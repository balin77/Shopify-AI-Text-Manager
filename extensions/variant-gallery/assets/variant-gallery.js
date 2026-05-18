const CP_LOG = '[cp-variant-gallery]';

class CpVariantGallery extends HTMLElement {
  connectedCallback() {
    console.info(CP_LOG, 'connected. block:', this.dataset.blockId, 'initial variant:', this.dataset.currentVariant);
    this._data       = this._loadData();
    this._mainImg    = this.querySelector('.cp-gallery__main-image');
    this._currentId  = this.dataset.currentVariant ? String(this.dataset.currentVariant) : null;

    this._bindThumbs();
    this._watchVariant();
  }

  _loadData() {
    const el = document.getElementById('cp-gallery-data-' + this.dataset.blockId);
    if (!el) { console.warn(CP_LOG, 'data <script> not found for block', this.dataset.blockId); return {}; }
    try {
      const parsed = JSON.parse(el.textContent);
      console.info(CP_LOG, 'data parsed. variant ids:', Object.keys(parsed));
      return parsed;
    } catch (err) {
      console.error(CP_LOG, 'JSON parse failed:', err, '\nraw:', el.textContent);
      return {};
    }
  }

  /* ---------- variant detection (theme-agnostic) ---------- */

  _watchVariant() {
    const handler = () => this._onVariantMaybeChanged();

    // Older themes that fire a DOM event.
    document.addEventListener('variant:change', (e) => {
      const id = e.detail && e.detail.variant && e.detail.variant.id;
      if (id) this._switchVariant(id);
    });
    document.addEventListener('variant_change', handler);

    // Universal fallback: native change on a variant selector.
    document.addEventListener('change', (e) => {
      if (e.target && e.target.matches && e.target.matches('[name="id"]')) handler();
    });

    // Modern Dawn sets input[name="id"].value programmatically (no change event)
    // and updates the URL — observe both.
    const input = this._variantInput();
    if (input && 'MutationObserver' in window) {
      this._mo = new MutationObserver(handler);
      this._mo.observe(input, { attributes: true, attributeFilter: ['value'] });
      // <select> changes the selected option, not a value attribute.
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
      const url = new URL(window.location.href);
      const v = url.searchParams.get('variant');
      if (v) return String(v);
    } catch (_) { /* noop */ }
    return null;
  }

  _onVariantMaybeChanged() {
    const id = this._resolveVariantId();
    if (id && id !== this._currentId) {
      console.info(CP_LOG, 'variant change detected:', this._currentId, '->', id);
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
    const id     = String(variantId);
    this._currentId = id;
    const images = this._data[id];
    const inner  = this.querySelector('.cp-gallery__inner');
    if (!inner) { console.warn(CP_LOG, 'no .cp-gallery__inner'); return; }

    if (!images || images.length === 0) {
      console.info(CP_LOG, 'no images for variant', id, '— clearing custom gallery');
      inner.innerHTML = '';
      return;
    }
    console.info(CP_LOG, 'rendering', images.length, 'image(s) for variant', id);

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

    inner.innerHTML = mainHtml + thumbsHtml;
    this._mainImg = this.querySelector('.cp-gallery__main-image');
    this._bindThumbs();
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

if (!customElements.get('cp-variant-gallery')) {
  customElements.define('cp-variant-gallery', CpVariantGallery);
}
