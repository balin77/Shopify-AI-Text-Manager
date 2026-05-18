class CpVariantGallery extends HTMLElement {
  connectedCallback() {
    this._data       = this._loadData();
    this._mainImg    = this.querySelector('.cp-gallery__main-image');
    this._currentId  = this.dataset.currentVariant ? String(this.dataset.currentVariant) : null;

    this._bindThumbs();
    this._watchVariant();
  }

  _loadData() {
    const el = document.getElementById('cp-gallery-data-' + this.dataset.blockId);
    if (!el) return {};
    try { return JSON.parse(el.textContent); } catch (_) { return {}; }
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
    if (id && id !== this._currentId) this._switchVariant(id);
  }

  /* ---------- rendering ---------- */

  _bindThumbs() {
    this.querySelectorAll('.cp-gallery__thumb').forEach((thumb) => {
      thumb.addEventListener('click', () => this._activateThumb(thumb));
    });
  }

  _activateThumb(thumb) {
    if (!this._mainImg) return;
    this._mainImg.src    = thumb.dataset.src800;
    this._mainImg.srcset = [
      thumb.dataset.src400  + ' 400w',
      thumb.dataset.src800  + ' 800w',
      thumb.dataset.src1200 + ' 1200w',
    ].join(', ');
    this.querySelectorAll('.cp-gallery__thumb').forEach((t) => t.classList.remove('is-active'));
    thumb.classList.add('is-active');
  }

  _switchVariant(variantId) {
    const id     = String(variantId);
    this._currentId = id;
    const images = this._data[id];
    const inner  = this.querySelector('.cp-gallery__inner');
    if (!inner) return;

    if (!images || images.length === 0) {
      inner.innerHTML = '';
      return;
    }

    const first = images[0];

    const mainHtml = `
      <div class="cp-gallery__main">
        <img
          class="cp-gallery__main-image"
          src="${first.src_800}"
          srcset="${first.src_400} 400w, ${first.src_800} 800w, ${first.src_1200} 1200w"
          sizes="(min-width: 1024px) 50vw, 100vw"
          alt="${this._esc(first.alt)}"
          loading="eager"
          width="800"
        >
      </div>`;

    let thumbsHtml = '';
    if (images.length > 1) {
      const items = images.map((img, i) => `
        <button
          class="cp-gallery__thumb${i === 0 ? ' is-active' : ''}"
          type="button"
          data-src-400="${img.src_400}"
          data-src-800="${img.src_800}"
          data-src-1200="${img.src_1200}"
        >
          <img src="${img.thumb}" alt="${this._esc(img.alt)} ${i + 1}" loading="lazy" width="160" height="160">
        </button>`).join('');
      thumbsHtml = `<div class="cp-gallery__thumbs">${items}</div>`;
    }

    inner.innerHTML = mainHtml + thumbsHtml;
    this._mainImg = this.querySelector('.cp-gallery__main-image');
    this._bindThumbs();
  }

  _esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('cp-variant-gallery')) {
  customElements.define('cp-variant-gallery', CpVariantGallery);
}
