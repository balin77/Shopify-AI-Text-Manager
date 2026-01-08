/**
 * Product List Component
 */
import { appState } from '../modules/state.js';
import { escapeHtml } from '../utils/dom.utils.js';

export class ProductListComponent {
  constructor(containerId = 'productsList') {
    this.container = document.getElementById(containerId);
  }

  showLoading() {
    this.container.innerHTML = `
      <div class="loading">
        <div class="spinner"></div>
        <p>Lade Produkte...</p>
      </div>
    `;
  }

  showError(message) {
    this.container.innerHTML = `<div class="error-message">Fehler: ${escapeHtml(message)}</div>`;
  }

  render(products, selectedProductId = null) {
    if (products.length === 0) {
      this.container.innerHTML = '<div class="empty-state"><p>Keine Produkte gefunden</p></div>';
      return;
    }

    this.container.innerHTML = products
      .map(
        (product) => `
      <div
        class="product-item ${selectedProductId === product.id ? 'active' : ''}"
        data-product-id="${product.id}"
      >
        <div class="product-item-content">
          ${product.featuredImage
            ? `<img src="${product.featuredImage}" alt="${escapeHtml(product.title)}" class="product-thumbnail" onerror="this.style.display='none'">`
            : `<div class="product-thumbnail-placeholder">📦</div>`
          }
          <div class="product-info-text">
            <div class="product-title">${escapeHtml(product.title)}</div>
            <div class="product-type">${escapeHtml(product.productType || 'Kein Typ')}</div>
          </div>
        </div>
      </div>
    `
      )
      .join('');

    // Attach click listeners
    this.attachClickListeners();
  }

  attachClickListeners() {
    const productItems = this.container.querySelectorAll('.product-item');
    productItems.forEach((item) => {
      item.addEventListener('click', () => {
        const productId = item.getAttribute('data-product-id');
        if (window.app && window.app.selectProduct) {
          window.app.selectProduct(productId);
        }
      });
    });
  }
}

// Create singleton instance
export const productList = new ProductListComponent();
