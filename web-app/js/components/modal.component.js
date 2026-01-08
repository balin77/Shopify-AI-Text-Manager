/**
 * Modal Component - Handles modal dialogs
 */
export class ModalComponent {
  constructor(containerId = 'modalContainer') {
    this.container = document.getElementById(containerId);
    this.pendingAction = null;
  }

  show(options) {
    const { title, message, buttons } = options;

    const buttonsHtml = buttons
      .map(
        (btn) => `
      <button class="modal-btn modal-btn-${btn.type}" onclick="${btn.onClick}">
        ${btn.label}
      </button>
    `
      )
      .join('');

    this.container.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-content">
          <h3 class="modal-title">${title}</h3>
          <p class="modal-message">${message}</p>
          <div class="modal-actions">
            ${buttonsHtml}
          </div>
        </div>
      </div>
    `;
  }

  showUnsavedChangesModal(onContinue) {
    this.pendingAction = onContinue;

    this.container.innerHTML = `
      <div class="modal-overlay">
        <div class="modal-content">
          <h3 class="modal-title">⚠️ Ungespeicherte Änderungen</h3>
          <p class="modal-message">
            Du hast ungespeicherte Änderungen. Möchtest du diese speichern, bevor du fortfährst?
          </p>
          <div class="modal-actions">
            <button class="modal-btn modal-btn-cancel" id="modal-cancel-btn">
              Abbrechen
            </button>
            <button class="modal-btn modal-btn-discard" id="modal-discard-btn">
              Verwerfen
            </button>
            <button class="modal-btn modal-btn-save" id="modal-save-btn">
              Speichern & Fortfahren
            </button>
          </div>
        </div>
      </div>
    `;

    // Attach event listeners
    document.getElementById('modal-cancel-btn').addEventListener('click', () => this.close());
    document.getElementById('modal-discard-btn').addEventListener('click', () => this.discardChanges());
    document.getElementById('modal-save-btn').addEventListener('click', () => this.saveAndContinue());
  }

  showUnsavedChanges(onSave, onDiscard, onCancel) {
    this.show({
      title: '⚠️ Ungespeicherte Änderungen',
      message: 'Du hast ungespeicherte Änderungen. Möchtest du diese speichern, bevor du fortfährst?',
      buttons: [
        { type: 'cancel', label: 'Abbrechen', onClick: 'modal.close()' },
        { type: 'discard', label: 'Verwerfen', onClick: 'modal.discard()' },
        { type: 'save', label: 'Speichern & Fortfahren', onClick: 'modal.saveAndContinue()' },
      ],
    });

    this.pendingAction = { onSave, onDiscard, onCancel };
  }

  discardChanges() {
    if (typeof this.pendingAction === 'function') {
      this.pendingAction();
    }
    this.close();
  }

  close() {
    this.container.innerHTML = '';
    this.pendingAction = null;
  }

  async saveAndContinue() {
    if (typeof this.pendingAction === 'function') {
      // For new modal
      this.close();
      if (window.app && window.app.saveTranslation) {
        await window.app.saveTranslation();
        this.pendingAction();
      }
    } else if (this.pendingAction?.onSave) {
      // For old modal
      await this.pendingAction.onSave();
      this.close();
    }
  }

  discard() {
    if (this.pendingAction?.onDiscard) {
      this.pendingAction.onDiscard();
    }
    this.close();
  }
}

// Create singleton instance
export const modal = new ModalComponent();
