import { LANGUAGES } from '../modules/constants.js';
import { appState } from '../modules/state.js';
import { modal } from './modal.component.js';
import { checkForChanges, updateSaveButton, storeOriginalData } from '../utils/change-tracker.js';
import { apiService } from '../services/api.service.js';

/**
 * Language Selector Component
 */
class LanguageSelectorComponent {
  /**
   * Get translation status for a language
   */
  getTranslationStatus(translations) {
    const requiredFields = ['title', 'description', 'seoTitle', 'metaDescription'];
    const missing = requiredFields.filter((field) => !translations[field]);

    if (missing.length === 0) return 'complete';
    if (missing.length === requiredFields.length) return 'missing';
    return 'partial';
  }

  /**
   * Render language selector
   */
  render() {
    return `
      <div class="language-selector">
        ${Object.entries(LANGUAGES)
          .map(([code, name]) => {
            const isActive = appState.currentLanguage === code;
            const trans = appState.productTranslations[code] || {};
            const status = code === 'de' ? 'complete' : this.getTranslationStatus(trans);
            const statusClass = isActive ? 'active' : `status-${status}`;

            return `
              <button class="lang-btn ${statusClass}" data-lang="${code}">
                ${name}
              </button>
            `;
          })
          .join('')}
      </div>
    `;
  }

  /**
   * Switch language with unsaved changes check
   */
  async switchLanguage(lang, onSwitchCallback) {
    // Check for unsaved changes
    const hasChanges = checkForChanges(appState.descriptionMode);

    if (hasChanges) {
      // Show modal and set callback
      modal.showUnsavedChangesModal(async () => {
        await this.switchLanguageInternal(lang, onSwitchCallback);
      });
      return;
    }

    await this.switchLanguageInternal(lang, onSwitchCallback);
  }

  /**
   * Internal language switch
   */
  async switchLanguageInternal(lang, onSwitchCallback) {
    appState.setCurrentLanguage(lang);
    appState.setHasUnsavedChanges(false);

    // Reset original data to prevent false change detection
    storeOriginalData({
      title: '',
      description: '',
      handle: '',
      seoTitle: '',
      metaDescription: '',
    });

    // Reload product detail with new language
    if (appState.selectedProduct) {
      const data = await apiService.getProduct(appState.selectedProduct.id);
      if (data.success) {
        appState.setProductTranslations(data.translations || {});
        if (onSwitchCallback) {
          onSwitchCallback(data.product);
        }
      }
    }
  }

  /**
   * Attach event listeners
   */
  attachEventListeners(onSwitchCallback) {
    const buttons = document.querySelectorAll('.lang-btn');
    buttons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const lang = btn.getAttribute('data-lang');
        this.switchLanguage(lang, onSwitchCallback);
      });
    });
  }
}

export const languageSelector = new LanguageSelectorComponent();
