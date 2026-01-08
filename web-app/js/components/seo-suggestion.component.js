import { appState } from '../modules/state.js';
import { apiService } from '../services/api.service.js';
import { escapeHtml } from '../utils/dom.utils.js';
import { LANGUAGES } from '../modules/constants.js';

/**
 * SEO Suggestion Component
 */
class SeoSuggestionComponent {
  /**
   * Request SEO suggestion from AI
   */
  async suggestSEO() {
    const suggestionContainer = document.getElementById('suggestionContainer');
    suggestionContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>KI erstellt Vorschlag...</p></div>';

    try {
      const data = await apiService.suggestSEO(appState.selectedProduct.id);

      if (data.success) {
        appState.setCurrentSuggestion(data.suggestion);
        this.renderSuggestion(data.suggestion);
      } else {
        suggestionContainer.innerHTML = `<div class="error-message">Fehler: ${data.error}</div>`;
      }
    } catch (error) {
      suggestionContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }

  /**
   * Render suggestion box
   */
  renderSuggestion(suggestion) {
    const suggestionContainer = document.getElementById('suggestionContainer');
    suggestionContainer.innerHTML = `
      <div class="suggestion-box">
        <h3>🤖 KI-Vorschlag</h3>

        <div class="field-group">
          <label class="field-label">SEO-Titel</label>
          <input
            type="text"
            class="editable-field"
            id="suggestion-seoTitle"
            value="${escapeHtml(suggestion.seoTitle)}"
          />
          <div class="field-meta" id="suggestion-seoTitle-length">${suggestion.seoTitle.length} Zeichen</div>
        </div>

        <div class="field-group">
          <label class="field-label">Meta-Description</label>
          <textarea
            class="editable-field"
            id="suggestion-metaDescription"
          >${escapeHtml(suggestion.metaDescription)}</textarea>
          <div class="field-meta" id="suggestion-metaDescription-length">${suggestion.metaDescription.length} Zeichen</div>
        </div>

        <div class="suggestion-item">
          <label>Begründung</label>
          <div class="reasoning">${escapeHtml(suggestion.reasoning)}</div>
        </div>

        <div class="suggestion-actions">
          <button class="btn btn-accept" id="accept-suggestion-btn">
            ✅ Akzeptieren & Übersetzen
          </button>
          <button class="btn btn-reject" id="reject-suggestion-btn">
            ❌ Ablehnen
          </button>
        </div>
      </div>
    `;

    this.attachSuggestionListeners();
  }

  /**
   * Attach event listeners to suggestion fields
   */
  attachSuggestionListeners() {
    // Character counters
    const seoTitleInput = document.getElementById('suggestion-seoTitle');
    const metaDescInput = document.getElementById('suggestion-metaDescription');

    if (seoTitleInput) {
      seoTitleInput.addEventListener('input', (e) => {
        document.getElementById('suggestion-seoTitle-length').textContent = `${e.target.value.length} Zeichen`;
        appState.currentSuggestion.seoTitle = e.target.value;
      });
    }

    if (metaDescInput) {
      metaDescInput.addEventListener('input', (e) => {
        document.getElementById('suggestion-metaDescription-length').textContent = `${e.target.value.length} Zeichen`;
        appState.currentSuggestion.metaDescription = e.target.value;
      });
    }

    // Action buttons
    const acceptBtn = document.getElementById('accept-suggestion-btn');
    const rejectBtn = document.getElementById('reject-suggestion-btn');

    if (acceptBtn) {
      acceptBtn.addEventListener('click', () => this.acceptSuggestion());
    }

    if (rejectBtn) {
      rejectBtn.addEventListener('click', () => this.rejectSuggestion());
    }
  }

  /**
   * Accept suggestion and translate
   */
  async acceptSuggestion() {
    if (!appState.currentSuggestion) return;

    // Get current values from editable fields
    appState.currentSuggestion.seoTitle = document.getElementById('suggestion-seoTitle').value;
    appState.currentSuggestion.metaDescription = document.getElementById('suggestion-metaDescription').value;

    const messageContainer = document.getElementById('messageContainer');
    messageContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Speichere und übersetze...</p></div>';

    try {
      // First apply SEO
      const seoData = await apiService.applySEO(appState.selectedProduct.id, {
        seoTitle: appState.currentSuggestion.seoTitle,
        metaDescription: appState.currentSuggestion.metaDescription,
      });

      if (!seoData.success) {
        messageContainer.innerHTML = `<div class="error-message">Fehler beim Speichern: ${seoData.error}</div>`;
        return;
      }

      // Then translate
      const translateData = await apiService.translateProduct(appState.selectedProduct.id, {
        seoTitle: appState.currentSuggestion.seoTitle,
        metaDescription: appState.currentSuggestion.metaDescription,
      });

      if (translateData.success) {
        messageContainer.innerHTML = `
          <div class="success-message">
            <strong>✅ Erfolgreich!</strong><br>
            SEO-Daten wurden gespeichert und in ${Object.keys(translateData.translations).join(', ').toUpperCase()} übersetzt.
          </div>
        `;

        // Clear suggestion
        document.getElementById('suggestionContainer').innerHTML = '';
        appState.setCurrentSuggestion(null);

        // Reload product
        setTimeout(() => {
          if (window.app && window.app.selectProduct) {
            window.app.selectProduct(appState.selectedProduct.id);
          }
        }, 2000);
      } else {
        messageContainer.innerHTML = `<div class="error-message">Fehler bei Übersetzung: ${translateData.error}</div>`;
      }
    } catch (error) {
      messageContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }

  /**
   * Reject suggestion
   */
  rejectSuggestion() {
    document.getElementById('suggestionContainer').innerHTML = '';
    document.getElementById('messageContainer').innerHTML = '<div class="error-message">Vorschlag wurde abgelehnt.</div>';
    appState.setCurrentSuggestion(null);

    setTimeout(() => {
      document.getElementById('messageContainer').innerHTML = '';
    }, 3000);
  }

  /**
   * Translate current SEO data directly
   */
  async translateDirect() {
    const messageContainer = document.getElementById('messageContainer');

    // Get current SEO data from editable fields
    const seoTitle = document.getElementById('field-seoTitle').value;
    const metaDescription = document.getElementById('field-metaDescription').value;

    if (!seoTitle || !metaDescription) {
      messageContainer.innerHTML = `<div class="error-message">SEO-Titel und Meta-Description müssen zuerst gesetzt werden!</div>`;
      return;
    }

    messageContainer.innerHTML = '<div class="loading"><div class="spinner"></div><p>Übersetze...</p></div>';

    try {
      const translateData = await apiService.translateProduct(appState.selectedProduct.id, {
        seoTitle,
        metaDescription,
      });

      if (translateData.success) {
        messageContainer.innerHTML = `
          <div class="success-message">
            <strong>✅ Übersetzungen hochgeladen!</strong><br>
            Sprachen: ${Object.keys(translateData.translations).join(', ').toUpperCase()}
          </div>
        `;

        setTimeout(() => {
          messageContainer.innerHTML = '';
          if (window.app && window.app.selectProduct) {
            window.app.selectProduct(appState.selectedProduct.id);
          }
        }, 3000);
      } else {
        messageContainer.innerHTML = `<div class="error-message">Fehler: ${translateData.error}</div>`;
      }
    } catch (error) {
      messageContainer.innerHTML = `<div class="error-message">Fehler: ${error.message}</div>`;
    }
  }
}

export const seoSuggestion = new SeoSuggestionComponent();
