import { App, Modal, Notice } from 'obsidian';
import * as logger from './logger';
import { submitManualComposerNotification } from './manual-composer';

export interface ManualComposerModalHost {
    send(body: string, title: string): Promise<void>;
    canShowResult(): boolean;
    release(modal: ManualComposerModal): void;
}

export class ManualComposerModal extends Modal {
    private titleValue = '';
    private bodyValue = '';
    private isSending = false;
    private isClosed = false;

    constructor(app: App, private readonly host: ManualComposerModalHost) {
        super(app);
    }

    onOpen(): void {
        this.modalEl.addClass('tps-messager-composer');
        this.setTitle('Send Custom Notification');
        const { contentEl } = this;
        contentEl.empty();

        const container = contentEl.createDiv({ cls: 'tps-messager-composer-form' });
        const titleBlock = container.createDiv({ cls: 'tps-messager-field' });
        const titleLabel = titleBlock.createEl('label', { text: 'Title', cls: 'tps-messager-label' });
        const titleInput = titleBlock.createEl('input', { type: 'text', placeholder: 'Notification Title' });
        titleInput.id = 'tps-messager-composer-title';
        titleLabel.setAttr('for', titleInput.id);
        titleInput.addEventListener('input', (event) => {
            this.titleValue = (event.target as HTMLInputElement).value;
        });

        const bodyBlock = container.createDiv({ cls: 'tps-messager-field' });
        const bodyLabel = bodyBlock.createEl('label', { text: 'Message', cls: 'tps-messager-label' });
        const bodyInput = bodyBlock.createEl('textarea', { placeholder: 'Message Body' });
        bodyInput.id = 'tps-messager-composer-body';
        bodyLabel.setAttr('for', bodyInput.id);
        bodyInput.rows = 4;
        bodyInput.addEventListener('input', (event) => {
            this.bodyValue = (event.target as HTMLTextAreaElement).value;
        });

        const statusEl = container.createDiv({ cls: 'tps-messager-status' });
        statusEl.setAttr('role', 'status');
        statusEl.setAttr('aria-live', 'polite');

        const actions = container.createDiv({ cls: 'tps-messager-composer-actions' });
        const cancelButton = actions.createEl('button', { text: 'Cancel', attr: { type: 'button' } });
        cancelButton.addEventListener('click', () => this.close());
        const sendButton = actions.createEl('button', {
            text: 'Send',
            cls: 'mod-cta',
            attr: { type: 'button' },
        });
        sendButton.addEventListener('click', () => {
            void this.submit(container, titleInput, bodyInput, statusEl, sendButton, cancelButton);
        });

        const submitShortcut = (event: KeyboardEvent): void => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                if (!this.isSending) sendButton.click();
            }
        };
        titleInput.addEventListener('keydown', submitShortcut);
        bodyInput.addEventListener('keydown', submitShortcut);
        titleInput.focus();
    }

    onClose(): void {
        const closedDuringSend = this.isSending;
        this.isClosed = true;
        this.host.release(this);
        this.contentEl.empty();
        if (closedDuringSend && this.host.canShowResult()) {
            new Notice('Notification sending continues. TPS Notifier will report the final result when known.');
        }
    }

    private async submit(
        container: HTMLElement,
        titleInput: HTMLInputElement,
        bodyInput: HTMLTextAreaElement,
        statusEl: HTMLElement,
        sendButton: HTMLButtonElement,
        cancelButton: HTMLButtonElement,
    ): Promise<void> {
        if (this.isSending) {
            logger.flowWarn('ManualComposer', 'submit:ignored', { reason: 'already-sending' });
            return;
        }

        this.isSending = true;
        container.setAttr('aria-busy', 'true');
        titleInput.disabled = true;
        bodyInput.disabled = true;
        sendButton.disabled = true;
        cancelButton.setText('Close (send continues)');
        statusEl.setText('Sending...');
        statusEl.removeClass('is-error');
        statusEl.addClass('is-sending');
        logger.flow('ManualComposer', 'submit:start', {
            hasTitle: !!this.titleValue.trim(),
            bodyLength: this.bodyValue.length,
        });

        const result = await submitManualComposerNotification(
            this.titleValue,
            this.bodyValue,
            async (body, title) => this.host.send(body, title),
        );
        logger.flow('ManualComposer', result.shouldClose ? 'submit:done' : 'submit:blocked', {
            shouldClose: result.shouldClose,
        });

        if (this.isClosed) {
            if (this.host.canShowResult()) {
                new Notice(result.shouldClose
                    ? 'Notification accepted by ntfy after the composer was closed.'
                    : result.statusText);
            }
            return;
        }

        if (result.shouldClose) {
            this.isSending = false;
            if (result.noticeText) new Notice(result.noticeText);
            this.close();
            return;
        }

        statusEl.setText(result.statusText);
        statusEl.removeClass('is-sending');
        statusEl.addClass('is-error');
        this.isSending = false;
        container.setAttr('aria-busy', 'false');
        titleInput.disabled = false;
        bodyInput.disabled = false;
        sendButton.disabled = false;
        cancelButton.setText('Cancel');
    }
}
