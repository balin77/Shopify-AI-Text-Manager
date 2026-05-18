class CpEmbedGallery extends HTMLElement {
  connectedCallback() {
    if (this._initialized) return;
    this._initialized = true;

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this._init());
    } else {
      this._init();
    }
  }

  _init() {
    this._data           = this._loadData();
    this._nativeSelector = this.dataset.nativeSelector || 'media-gallery';
    this._nativeGallery  = document.querySelector(this._nativeSelector);
    this._currentId      = null;

    if (!this._nativeGallery || !this._data) return;

    // Insert our gallery right before the native gallery in the DOM,
    // so it occupies the same visual position when the native is hidden.
    this._nativeGallery.parentNode.insertBefore(this, this._nativeGallery);

    // Show correct gallery for the variant selected on page load.
    const initialId = this._resolveVariantId();
    if (initialId) this._switchVariant(initialId);

    this._watchVariant();
  }

  _loadData() {
    const el = document.getElementById('cp-embed-data-' + this.dataset.blockId);
    if (!el) return null;
    try { return JSON.parse(el.textContent); } catch (_) { return null; }
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

  _hideNative() {
    if (!this._nativeGallery) return;
    this._nativeGallery.setAttribute('hidden', '');
    this._nativeGallery.style.display = 'none';
  }

  _showNative() {
    if (!this._nativeGallery) return;
    this._nativeGallery.removeAttribute('hidden');
    this._nativeGallery.style.display = '';
  }

  /* ---------- rendering ---------- */

  _switchVariant(variantId) {
    const id = String(variantId);
    this._currentId = id;
    const images = this._data[id];

    if (!images || images.length === 0) {
      // No variant gallery — restore native gallery.
      this.style.display = 'none';
      this._showNative();
      return;
    }

    // Has variant gallery — hide native, render ours.
    this._hideNative();
    this.style.display = 'block';
    this._render(images);
  }

  _render(images) {
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
        mainImg.src    = thumb.dataset.src800;
        mainImg.srcset = `${thumb.dataset.src400} 400w, ${thumb.dataset.src800} 800w, ${thumb.dataset.src1200} 1200w`;
        container.querySelectorAll('.cp-gallery__thumb').forEach((t) => t.classList.remove('is-active'));
        thumb.classList.add('is-active');
      });
    });
  }

  _esc(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('cp-embed-gallery')) {
  customElements.define('cp-embed-gallery', CpEmbedGallery);
}
