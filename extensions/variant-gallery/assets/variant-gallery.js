class CpVariantGallery extends HTMLElement {
  connectedCallback() {
    this._data     = this._loadData();
    this._mainImg  = this.querySelector('.cp-gallery__main-image');
    this._thumbsEl = this.querySelector('.cp-gallery__thumbs');

    this._bindThumbs();

    // Dawn Theme: dispatches 'variant:change' on the document
    document.addEventListener('variant:change', (e) => {
      const id = e.detail?.variant?.id;
      if (id) this._switchVariant(id);
    });

    // Universal fallback: native change on any variant selector
    document.addEventListener('change', (e) => {
      if (e.target.matches('[name="id"]')) {
        this._switchVariant(Number(e.target.value));
      }
    });
  }

  _loadData() {
    const el = document.getElementById('cp-gallery-data-' + this.dataset.sectionId);
    if (!el) return {};
    try { return JSON.parse(el.textContent); } catch (_) { return {}; }
  }

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
    const images = this._data[variantId];
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
    this._mainImg  = this.querySelector('.cp-gallery__main-image');
    this._thumbsEl = this.querySelector('.cp-gallery__thumbs');
    this._bindThumbs();
  }

  _esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }
}

if (!customElements.get('cp-variant-gallery')) {
  customElements.define('cp-variant-gallery', CpVariantGallery);
}
