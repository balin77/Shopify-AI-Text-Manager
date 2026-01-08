import { appState } from '../modules/state.js';
import { apiService } from '../services/api.service.js';
import { DESCRIPTION_MODES } from '../modules/constants.js';

/**
 * Rich Editor Component
 */
class RichEditorComponent {
  /**
   * Render formatting toolbar
   */
  renderToolbar() {
    return `
      <div class="formatting-toolbar">
        <button class="format-btn" data-command="bold" title="Fett"><strong>B</strong></button>
        <button class="format-btn" data-command="italic" title="Kursiv"><em>I</em></button>
        <button class="format-btn" data-command="underline" title="Unterstrichen"><u>U</u></button>
        <span style="border-left: 1px solid #cbd5e0; margin: 0 0.25rem;"></span>
        <button class="format-btn" data-command="h1" title="Überschrift 1">H1</button>
        <button class="format-btn" data-command="h2" title="Überschrift 2">H2</button>
        <button class="format-btn" data-command="h3" title="Überschrift 3">H3</button>
        <span style="border-left: 1px solid #cbd5e0; margin: 0 0.25rem;"></span>
        <button class="format-btn" data-command="ul" title="Aufzählung">• Liste</button>
        <button class="format-btn" data-command="ol" title="Nummerierte Liste">1. Liste</button>
        <span style="border-left: 1px solid #cbd5e0; margin: 0 0.25rem;"></span>
        <button class="format-btn" data-command="p" title="Absatz">¶ Absatz</button>
        <button class="format-btn" data-command="br" title="Zeilenumbruch">↵ Umbruch</button>
      </div>
    `;
  }

  /**
   * Format text in contenteditable div
   */
  formatText(command) {
    const descField = document.getElementById('field-description');
    descField.focus();

    switch (command) {
      case 'bold':
        document.execCommand('bold', false, null);
        break;
      case 'italic':
        document.execCommand('italic', false, null);
        break;
      case 'underline':
        document.execCommand('underline', false, null);
        break;
      case 'h1':
        document.execCommand('formatBlock', false, '<h1>');
        break;
      case 'h2':
        document.execCommand('formatBlock', false, '<h2>');
        break;
      case 'h3':
        document.execCommand('formatBlock', false, '<h3>');
        break;
      case 'p':
        document.execCommand('formatBlock', false, '<p>');
        break;
      case 'ul':
        document.execCommand('insertUnorderedList', false, null);
        break;
      case 'ol':
        document.execCommand('insertOrderedList', false, null);
        break;
      case 'br':
        document.execCommand('insertHTML', false, '<br>');
        break;
    }

    // Update character count
    const meta = document.getElementById('field-description-meta');
    if (meta) {
      meta.textContent = `${descField.innerText.length} Zeichen`;
    }
  }

  /**
   * Toggle between HTML and rendered mode
   */
  async toggleDescriptionMode(onToggleCallback) {
    const descField = document.getElementById('field-description');
    let currentContent = '';

    if (appState.descriptionMode === DESCRIPTION_MODES.RENDERED) {
      // Switch from rendered to HTML
      currentContent = descField.innerHTML;
    } else {
      // Switch from HTML to rendered
      currentContent = descField.value;
    }

    // Toggle mode
    const newMode = appState.descriptionMode === DESCRIPTION_MODES.HTML
      ? DESCRIPTION_MODES.RENDERED
      : DESCRIPTION_MODES.HTML;

    appState.setDescriptionMode(newMode);

    // Re-render with preserved content
    if (appState.selectedProduct && onToggleCallback) {
      const data = await apiService.getProduct(appState.selectedProduct.id);
      if (data.success) {
        appState.setProductTranslations(data.translations || {});
        await onToggleCallback(data.product);

        // Restore content after re-render
        const newDescField = document.getElementById('field-description');
        if (newMode === DESCRIPTION_MODES.RENDERED) {
          newDescField.innerHTML = currentContent;
        } else {
          newDescField.value = currentContent;
        }
      }
    }
  }

  /**
   * Attach event listeners to toolbar
   */
  attachEventListeners() {
    const formatButtons = document.querySelectorAll('.format-btn');
    formatButtons.forEach((btn) => {
      btn.addEventListener('click', () => {
        const command = btn.getAttribute('data-command');
        this.formatText(command);
      });
    });
  }
}

export const richEditor = new RichEditorComponent();
