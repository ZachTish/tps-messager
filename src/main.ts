import { Notice, Plugin, TFile, Modal, App, requestUrl } from 'obsidian';
import * as logger from "./logger";
import { TPSNotifierSettings } from './types';
import { TPSNotifierSettingTab } from './settings-tab';
import { buildNtfyUrl } from './ntfy-url';
import { prepareNotifierRequest, type PreparedNotifierRequest } from './ntfy-request';
import { submitManualComposerNotification } from './manual-composer';
import { changedNotifierSettingsKeys, DEFAULT_SETTINGS, isFutureNotifierSettings, mergeNotifierSettingsChanges, sanitizeNotifierSettings } from './settings-migration';
import { normalizeNotifierProtocolPath, sanitizeNotifierDeliveryError, summarizeNotifierTarget } from './notifier-safety';

// ============================================================================
// MAIN PLUGIN CLASS
// ============================================================================

export default class TPSNotifier extends Plugin {
    settings: TPSNotifierSettings;
    private settingsSavePromise: Promise<void> | null = null;
    private settingsSavePending = false;
    private readonly uncertainSettingsSaveKeys = new Set<string>();
    private lastSavedSettingsSnapshot: TPSNotifierSettings | null = null;
    private settingsPersistenceBlocked = false;
    private settingsPersistenceBlockedReason: 'load-failed' | 'future-schema' | null = null;
    private settingsPersistenceBlockedNoticeShown = false;

    async onload() {
        logger.flow('Plugin', 'load:start');
        try {
            await this.loadSettings();
            logger.flow('Plugin', 'settings:loaded', {
                enabled: this.settings.enabled === true,
                manualComposer: this.settings.enableManualComposer ?? true,
                hasTopic: !!String(this.settings.ntfyTopic || '').trim(),
                priority: this.settings.ntfyPriority,
            });

            // Add Command to manually send a notification
            this.addCommand({
                id: 'send-custom-notification',
                name: 'Send Custom Notification',
                callback: () => {
                    if (!this.settings.enableManualComposer) {
                        logger.flowWarn('ManualComposer', 'open:blocked', { reason: 'disabled' });
                        new Notice('Manual composer command is disabled in settings.');
                        return;
                    }
                    logger.flow('ManualComposer', 'open');
                    this.openSendNotificationModal();
                },
            });
            this.addCommand({
                id: 'dry-run-notification-delivery',
                name: 'Validate Notification Delivery Setup (Dry Run)',
                callback: () => {
                    try {
                        const request = this.dryRunMessage('Dry run notification from TPS Notifier', undefined, 'TPS Notifier Dry Run');
                        new Notice(`Dry run prepared: ${request.url}`);
                    } catch (error) {
                        logger.flowError('Delivery', 'dry-run-command:failed', error);
                        const message = error instanceof Error ? error.message : 'Failed to prepare dry run notification.';
                        new Notice(message);
                    }
                },
            });

            // Add Settings Tab
            this.addSettingTab(new TPSNotifierSettingTab(this.app, this));

            // Keep tps-notifier as a protocol alias for links already sent.
            this.registerObsidianProtocolHandler('tps-messager', (params) => this.handleProtocolOpen(params));
            this.registerObsidianProtocolHandler('tps-notifier', (params) => this.handleProtocolOpen(params));

            // Expose API for other TPS plugins
            (this as any).api = {
                sendNotification: (title: string, body: string, file?: TFile) => this.sendMessage(body, file, title),
                sendMessage: (text: string, file?: TFile, title?: string) => this.sendMessage(text, file, title),
                dryRunMessage: (text: string, file?: TFile, title?: string) => this.dryRunMessage(text, file, title),
            };

        } catch (error) {
            logger.flowError('Plugin', 'load:failed', error);
            new Notice('TPS Notifier failed to load. Check console.');
        }
        logger.flow('Plugin', 'load:done');
    }

    onunload() {
        logger.flow('Plugin', 'unload');
        logger.setLoggingEnabled(false);
        delete (this as any).api;
    }

    async loadSettings() {
        try {
            const data = await this.loadData();
            this.settings = sanitizeNotifierSettings(data);
            this.lastSavedSettingsSnapshot = cloneNotifierSettings(this.settings);
            this.settingsPersistenceBlocked = isFutureNotifierSettings(data);
            this.settingsPersistenceBlockedReason = this.settingsPersistenceBlocked ? 'future-schema' : null;
            logger.setLoggingEnabled(this.settings.enableLogging);
            if (this.settingsPersistenceBlocked) {
                logger.flowWarn('Settings', 'future-schema:read-only', { settingsVersion: this.settings.settingsVersion });
                new Notice('TPS Notifier settings were written by a newer plugin version. This version will not overwrite them.', 12000);
            }
        } catch (e) {
            logger.flowError('Settings', 'load:failed', e);
            this.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
            this.lastSavedSettingsSnapshot = null;
            this.settingsPersistenceBlocked = true;
            this.settingsPersistenceBlockedReason = 'load-failed';
            logger.setLoggingEnabled(false);
            new Notice('TPS Notifier could not safely read its settings. Saving is disabled until the plugin reloads successfully.', 12000);
        }
    }

    async saveSettings() {
        this.settings = sanitizeNotifierSettings(this.settings);
        logger.setLoggingEnabled(this.settings.enableLogging);
        if (this.settingsPersistenceBlocked) {
            this.notifySettingsPersistenceBlocked();
            return;
        }
        this.settingsSavePending = true;
        if (this.settingsSavePromise) {
            logger.flow('Settings', 'save:queued');
            await this.settingsSavePromise;
            return;
        }

        const operation = Promise.resolve().then(() => this.flushSettingsSaveQueue());
        this.settingsSavePromise = operation;
        await operation;
    }

    private async flushSettingsSaveQueue(): Promise<void> {
      try {
        while (this.settingsSavePending && !this.settingsPersistenceBlocked) {
            this.settingsSavePending = false;
            const localSnapshot = cloneNotifierSettings(this.settings);
            const changedKeys = changedNotifierSettingsKeys(this.lastSavedSettingsSnapshot, localSnapshot);
            for (const key of this.uncertainSettingsSaveKeys) {
                if (!changedKeys.includes(key)) changedKeys.push(key);
            }
            if (!changedKeys.length) continue;
            let latestStored: unknown;
            try {
                latestStored = await this.loadData();
            } catch (error) {
                logger.flowError('Settings', 'save:read-latest-failed', error);
                this.settingsPersistenceBlocked = true;
                this.settingsPersistenceBlockedReason = 'load-failed';
                this.notifySettingsPersistenceBlocked();
                return;
            }
            if (isFutureNotifierSettings(latestStored)) {
                this.settingsPersistenceBlocked = true;
                this.settingsPersistenceBlockedReason = 'future-schema';
                logger.flowWarn('Settings', 'save:blocked-future-schema');
                this.notifySettingsPersistenceBlocked();
                return;
            }
            const persistencePayload = mergeNotifierSettingsChanges(latestStored, localSnapshot, changedKeys);
            logger.flow('Settings', 'save:start', {
                changedKeys,
                enabled: persistencePayload.enabled === true,
                manualComposer: persistencePayload.enableManualComposer ?? true,
                hasTopic: !!String(persistencePayload.ntfyTopic || '').trim(),
                priority: persistencePayload.ntfyPriority,
            });
            try {
                await this.saveData(persistencePayload);
                const mutationsDuringSave = changedNotifierSettingsKeys(localSnapshot, this.settings);
                this.lastSavedSettingsSnapshot = cloneNotifierSettings(persistencePayload);
                for (const key of changedKeys) this.uncertainSettingsSaveKeys.delete(key);
                this.settings = mutationsDuringSave.length
                    ? mergeNotifierSettingsChanges(persistencePayload, this.settings, mutationsDuringSave)
                    : sanitizeNotifierSettings(persistencePayload);
                logger.setLoggingEnabled(this.settings.enableLogging);
                logger.flow('Settings', 'save:done', { changedKeys });
            } catch (error) {
                for (const key of changedKeys) this.uncertainSettingsSaveKeys.add(key);
                logger.flowError('Settings', 'save:failed', error, {
                    enabled: localSnapshot.enabled === true,
                    hasTopic: !!String(localSnapshot.ntfyTopic || '').trim(),
                });
                if (!this.settingsSavePending) throw error;
            }
        }
      } finally {
        this.settingsSavePromise = null;
      }
    }

    private notifySettingsPersistenceBlocked(): void {
        logger.flowWarn('Settings', 'save:blocked', { reason: this.settingsPersistenceBlockedReason || 'unknown' });
        if (this.settingsPersistenceBlockedNoticeShown) return;
        this.settingsPersistenceBlockedNoticeShown = true;
        const message = this.settingsPersistenceBlockedReason === 'future-schema'
            ? 'TPS Notifier did not save because this vault contains settings from a newer TPS Notifier version. Update this device first.'
            : 'TPS Notifier did not save because its settings could not be read safely. Reload the plugin and try again.';
        new Notice(message, 12000);
    }

    log(message: string, ...args: any[]) {
        logger.log(`[TPS Notifier] ${message}`, ...args);
    }

    // ========================================================================
    // NOTIFICATION SENDING
    // ========================================================================

    buildObsidianLink(file?: TFile): string {
        if (!file) return '';
        const vaultName = encodeURIComponent(this.app.vault.getName());
        const filePath = encodeURIComponent(file.path);
        return `obsidian://tps-messager?vault=${vaultName}&file=${filePath}`;
    }

    getNtfyUrl(): string | null {
        return buildNtfyUrl(this.settings.ntfyServer, this.settings.ntfyTopic);
    }

    private async handleProtocolOpen(params: Record<string, string>): Promise<void> {
        logger.flow('Protocol', 'open:start', {
            hasVault: !!params.vault,
            hasFile: !!params.file,
        });
        let normalizedPath = '';
        try {
            const vault = typeof params.vault === 'string' ? params.vault : '';
            if (vault && vault !== this.app.vault.getName()) {
                logger.flowWarn('Protocol', 'open:blocked', { reason: 'vault-mismatch', vault });
                return;
            }
            normalizedPath = normalizeNotifierProtocolPath(params.file) || '';
            if (!normalizedPath) {
                logger.flowWarn('Protocol', 'open:blocked', {
                    reason: 'invalid-path',
                    inputLength: typeof params.file === 'string' ? params.file.length : 0,
                    containsPercent: typeof params.file === 'string' && params.file.includes('%'),
                });
                return;
            }
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!(file instanceof TFile)) {
                logger.flowWarn('Protocol', 'open:missing-file', { path: normalizedPath });
                new Notice('TPS Notifier could not find the linked file.');
                return;
            }
            const leaf = this.app.workspace.getLeaf(false);
            if (leaf) {
                await leaf.openFile(file);
                logger.flow('Protocol', 'open:done', { path: file.path });
            }
        } catch (error) {
            logger.flowError('Protocol', 'open:failed', error, { path: normalizedPath, hasFile: !!params.file });
            new Notice('TPS Notifier could not open the linked file.');
        }
    }

    async sendMessage(text: string, file?: TFile, title?: string) {
        let request;
        logger.flow('Delivery', 'send:start', {
            hasCustomTitle: !!String(title || '').trim(),
            titleLength: String(title || '').length,
            bodyLength: (text || '').length,
            hasFile: file instanceof TFile,
            path: file instanceof TFile ? file.path : undefined,
        });
        try {
            request = prepareNotifierRequest(
                this.settings,
                text,
                title,
                this.buildObsidianLink(file),
            );
        } catch (error) {
            logger.flowError('Delivery', 'send:prepare-failed', error, {
                enabled: this.settings.enabled === true,
                hasTopic: !!String(this.settings.ntfyTopic || '').trim(),
                hasServer: !!String(this.settings.ntfyServer || '').trim(),
            });
            const message = error instanceof Error ? error.message : 'Failed to prepare notification.';
            new Notice(message);
            throw error;
        }

        try {
            const target = summarizeNotifierTarget(request.url);
            logger.flow('Delivery', 'send:request', {
                ...target,
                priority: request.headers.Priority,
                hasClick: !!request.headers.Click,
                bodyLength: request.body.length,
            });
            const response = await requestUrl(request);

            if (response.status >= 200 && response.status < 300) {
                logger.flow('Delivery', 'send:done', {
                    status: response.status,
                    ...target,
                });
            } else {
                const err = response.text;
                logger.flowError('Delivery', 'send:http-failed', sanitizeNotifierDeliveryError(new Error(err || 'request failed'), request.url), {
                    status: response.status,
                    ...target,
                });
                throw new Error(`ntfy returned ${response.status}: ${err || 'request failed'}`);
            }
        } catch (error) {
            const safeError = sanitizeNotifierDeliveryError(error, request.url);
            logger.flowError('Delivery', 'send:failed', safeError, {
                ...summarizeNotifierTarget(request.url),
            });
            throw safeError;
        }
    }

    dryRunMessage(text: string, file?: TFile, title?: string): PreparedNotifierRequest {
        const request = prepareNotifierRequest(
            this.settings,
            text,
            title,
            this.buildObsidianLink(file),
        );
        logger.flow('Delivery', 'dry-run:prepared', {
            ...summarizeNotifierTarget(request.url),
            priority: request.headers.Priority,
            hasClick: !!request.headers.Click,
            bodyLength: request.body.length,
        });
        return request;
    }

    // ========================================================================
    // MANUAL SEND MODAL
    // ========================================================================

    openSendNotificationModal() {
        const modal = new (class extends Modal {
            title = '';
            body = '';
            isSending = false;
            plugin: TPSNotifier;

            constructor(app: App, plugin: TPSNotifier) {
                super(app);
                this.plugin = plugin;
            }

            onOpen() {
                this.modalEl.addClass("tps-keyboard-aware-modal");
                const { contentEl } = this;
                contentEl.empty();
                contentEl.createEl('h2', { text: 'Send Custom Notification' });

                const container = contentEl.createDiv();
                container.style.display = 'flex';
                container.style.flexDirection = 'column';
                container.style.gap = '10px';

                // Title Input
                const titleBlock = container.createDiv();
                titleBlock.createEl('label', { text: 'Title', cls: 'tps-messager-label' });
                const titleInput = titleBlock.createEl('input', { type: 'text', placeholder: 'Notification Title' });
                titleInput.style.width = '100%';
                titleInput.addEventListener('input', (e) => this.title = (e.target as HTMLInputElement).value);

                // Body Input
                const bodyBlock = container.createDiv();
                bodyBlock.createEl('label', { text: 'Message', cls: 'tps-messager-label' });
                const bodyInput = bodyBlock.createEl('textarea', { placeholder: 'Message Body' });
                bodyInput.style.width = '100%';
                bodyInput.rows = 4;
                bodyInput.addEventListener('input', (e) => this.body = (e.target as HTMLTextAreaElement).value);

                const statusEl = container.createDiv({ cls: 'tps-messager-label' });
                statusEl.style.minHeight = '1.2em';
                statusEl.style.color = 'var(--text-error)';

                // Buttons
                const btnContainer = container.createDiv();
                btnContainer.style.display = 'flex';
                btnContainer.style.justifyContent = 'flex-end';
                btnContainer.style.marginTop = '15px';
                btnContainer.style.gap = '10px';

                const cancelBtn = btnContainer.createEl('button', { text: 'Cancel' });
                cancelBtn.addEventListener('click', () => this.close());

                const sendBtn = btnContainer.createEl('button', { text: 'Send', cls: 'mod-cta' });
                sendBtn.addEventListener('click', async () => {
                    if (this.isSending) {
                        logger.flowWarn('ManualComposer', 'submit:ignored', { reason: 'already-sending' });
                        return;
                    }

                    this.isSending = true;
                    sendBtn.disabled = true;
                    statusEl.setText('Sending...');
                    statusEl.style.color = 'var(--text-muted)';
                    logger.flow('ManualComposer', 'submit:start', {
                        hasTitle: !!this.title.trim(),
                        bodyLength: this.body.length,
                    });

                    const result = await submitManualComposerNotification(
                        this.title,
                        this.body,
                        (body, title) => this.plugin.sendMessage(body, undefined, title),
                    );
                    logger.flow('ManualComposer', result.shouldClose ? 'submit:done' : 'submit:blocked', {
                        statusText: result.statusText,
                        noticeText: result.noticeText,
                    });
                    if (result.shouldClose) {
                        if (result.noticeText) new Notice(result.noticeText);
                        this.close();
                        return;
                    }
                    statusEl.setText(result.statusText);
                    statusEl.style.color = 'var(--text-error)';
                    this.isSending = false;
                    sendBtn.disabled = false;
                });
            }

            onClose() {
                this.contentEl.empty();
            }
        })(this.app, this);

        modal.open();
    }
}

function cloneNotifierSettings(settings: TPSNotifierSettings): TPSNotifierSettings {
    return JSON.parse(JSON.stringify(settings));
}
