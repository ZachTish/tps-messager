import { App, ButtonComponent, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TPSNotifier from './main';
import { getManualComposerFailureMessage } from './manual-composer';
import { isNotifierError } from './notifier-errors';
import type { TransportSettingsDraft } from './types';
import * as logger from './logger';

type DisableableControl = { setDisabled(disabled: boolean): unknown };

const createCollapsibleSection = (
    parent: HTMLElement,
    title: string,
    description?: string,
    defaultOpen = false,
): HTMLElement => {
    const details = parent.createEl('details', { cls: 'tps-notifier-collapsible-section' });
    if (defaultOpen) details.setAttr('open', 'true');
    const summary = details.createEl('summary', { cls: 'tps-notifier-collapsible-section-summary' });
    summary.createSpan({ cls: 'tps-notifier-collapsible-section-title', text: title });
    if (description) {
        details.createEl('p', {
            cls: 'tps-notifier-collapsible-section-description',
            text: description,
        });
    }
    return details.createDiv({ cls: 'tps-notifier-collapsible-section-content' });
};

export class TPSNotifierSettingTab extends PluginSettingTab {
    private readonly plugin: TPSNotifier;
    private readonly uiLifecycleToken: number;
    private settingsViewState = new Map<string, boolean>();
    private settingsScrollTop = 0;
    private hasRenderedSettings = false;
    private transportDraft: TransportSettingsDraft | null = null;
    private transportDraftDirty = false;
    private transportCommitInFlight = false;
    private settingsActionInFlight = false;
    private testSendInFlight = false;
    private isTabVisible = false;
    private applyTransportButton: ButtonComponent | null = null;
    private discardTransportButton: ButtonComponent | null = null;
    private testSendButton: ButtonComponent | null = null;
    private applyTransportSetting: Setting | null = null;
    private deliveryToggle: DisableableControl | null = null;
    private readonly settingsControls = new Set<DisableableControl>();

    constructor(app: App, plugin: TPSNotifier) {
        super(app, plugin);
        this.plugin = plugin;
        this.uiLifecycleToken = plugin.getUiLifecycleToken();
    }

    display(): void {
        this.isTabVisible = true;
        const { containerEl } = this;
        this.captureSettingsViewState(containerEl);
        this.settingsControls.clear();
        this.deliveryToggle = null;
        this.testSendButton = null;
        containerEl.empty();
        containerEl.addClass('tps-notifier-settings');
        if (!this.transportDraft) this.resetTransportDraft(false);
        const draft = this.transportDraft as TransportSettingsDraft;
        const blockedReason = this.plugin.getSettingsWriteBlockedReason();
        const warningReason = this.plugin.getSettingsWarningReason();
        const settingsBlocked = !!blockedReason;

        containerEl.createEl('h2', { text: 'TPS Notifier Settings' });
        containerEl.createEl('p', {
            text: 'Configure and apply the complete ntfy target before enabling delivery. Unsaved edits stay separate; an enabled transport continues using its last applied target.',
            cls: 'setting-item-description',
        });
        if (blockedReason || warningReason) {
            const warning = containerEl.createEl('p', {
                text: blockedReason || warningReason,
                cls: 'tps-notifier-settings-warning',
            });
            warning.setAttr('role', blockedReason ? 'alert' : 'status');
        }

        const coreSettings = containerEl.createDiv({ cls: 'tps-settings-core' });
        new Setting(coreSettings).setName('Core settings').setHeading();

        new Setting(coreSettings)
            .setName('Enable delivery transport')
            .setDesc('Enabling is durable before it becomes active. Disabling blocks new sends while its durable save is pending.')
            .addToggle(toggle => {
                this.registerSettingsControl(toggle);
                this.deliveryToggle = toggle;
                toggle.toggleEl.setAttr('data-tps-notifier-focus', 'delivery');
                toggle
                .setDisabled(settingsBlocked
                    || !!warningReason
                    || this.settingsActionInFlight
                    || this.transportCommitInFlight
                    || (!this.plugin.settings.enabled && this.transportDraftDirty))
                .setValue(this.plugin.settings.enabled === true)
                .onChange(async (value) => {
                    toggle.setDisabled(true);
                    await this.runSettingsAction(() => this.plugin.setDeliveryEnabled(value));
                    this.redisplayIfVisible('delivery');
                });
            });

        new Setting(coreSettings)
            .setName('ntfy Server')
            .setDesc('HTTP(S) server or reverse-proxy base path. Plain HTTP sends notification content unencrypted. Embedded credentials, query parameters, fragments, controls, backslashes, and URLs over 2,048 characters are rejected.')
            .addText(text => {
                this.registerSettingsControl(text);
                text.inputEl.setAttr('data-tps-notifier-focus', 'server');
                text
                .setDisabled(settingsBlocked || this.settingsActionInFlight || this.transportCommitInFlight)
                .setPlaceholder('https://ntfy.sh')
                .setValue(draft.ntfyServer)
                .onChange((value) => {
                    if (this.transportCommitInFlight) return;
                    draft.ntfyServer = value;
                    this.updateTransportDirtyState();
                });
            });

        new Setting(coreSettings)
            .setName('ntfy Topic')
            .setDesc('Treat the topic like a password: use 1-64 hard-to-guess letters, numbers, hyphens, or underscores.')
            .addText(text => {
                this.registerSettingsControl(text);
                text
                .setDisabled(settingsBlocked || this.settingsActionInFlight || this.transportCommitInFlight)
                .setPlaceholder('private_alerts_random_suffix')
                .setValue(draft.ntfyTopic)
                .onChange((value) => {
                    if (this.transportCommitInFlight) return;
                    draft.ntfyTopic = value;
                    this.updateTransportDirtyState();
                });
            });

        new Setting(coreSettings)
            .setName('Priority')
            .setDesc('Notification priority (1-5)')
            .addSlider(slider => {
                this.registerSettingsControl(slider);
                slider
                .setDisabled(settingsBlocked || this.settingsActionInFlight || this.transportCommitInFlight)
                .setLimits(1, 5, 1)
                .setValue(draft.ntfyPriority)
                .setDynamicTooltip()
                .onChange((value) => {
                    if (this.transportCommitInFlight) return;
                    draft.ntfyPriority = value;
                    this.updateTransportDirtyState();
                });
            });

        const applySetting = new Setting(coreSettings)
            .setName('Apply transport configuration')
            .setDesc(this.transportDescription());
        this.applyTransportSetting = applySetting;
        applySetting.addButton(button => {
            this.registerSettingsControl(button);
            this.applyTransportButton = button;
            button.buttonEl.setAttr('data-tps-notifier-focus', 'apply');
            button.setButtonText('Apply')
                .setCta()
                .setDisabled(settingsBlocked
                    || this.settingsActionInFlight
                    || this.transportCommitInFlight
                    || (!this.transportDraftDirty && !warningReason))
                .onClick(async () => {
                    if (this.transportCommitInFlight) return;
                    const snapshot = { ...draft };
                    this.transportCommitInFlight = true;
                    const applied = await this.runSettingsAction(async () => {
                        await this.plugin.applyTransportSettings(snapshot);
                    });
                    this.transportCommitInFlight = false;
                    if (applied && this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) {
                        this.resetTransportDraft(false);
                        new Notice('ntfy transport configuration applied.');
                    }
                    this.redisplayIfVisible(applied ? 'server' : 'apply');
                });
        });
        applySetting.addButton(button => {
            this.registerSettingsControl(button);
            this.discardTransportButton = button;
            button.setButtonText('Discard draft')
                .setDisabled(this.settingsActionInFlight
                    || this.transportCommitInFlight
                    || !this.transportDraftDirty)
                .onClick(() => {
                    if (this.transportCommitInFlight) return;
                    this.resetTransportDraft(true);
                    this.redisplayIfVisible('server');
                });
        });

        const diagnostics = createCollapsibleSection(
            containerEl,
            'Manual Composer, Logging, and Delivery Test',
            'Optional tools for validating delivery and troubleshooting.',
        );

        new Setting(diagnostics)
            .setName('Enable manual composer command')
            .setDesc('Makes “Send Custom Notification” available in the command palette.')
            .addToggle(toggle => {
                this.registerSettingsControl(toggle);
                toggle.toggleEl.setAttr('data-tps-notifier-focus', 'composer');
                toggle
                .setDisabled(settingsBlocked || !!warningReason || this.settingsActionInFlight)
                .setValue(this.plugin.settings.enableManualComposer)
                .onChange(async (value) => {
                    toggle.setDisabled(true);
                    await this.runSettingsAction(() => (
                        this.plugin.setManualComposerEnabled(value)
                    ));
                    this.redisplayIfVisible('composer');
                });
            });

        new Setting(diagnostics)
            .setName('Enable Logging')
            .setDesc('Adds structured debug metadata. Errors are always logged, but notification content, topics, credentials, raw responses, and note paths are excluded.')
            .addToggle(toggle => {
                this.registerSettingsControl(toggle);
                toggle.toggleEl.setAttr('data-tps-notifier-focus', 'logging');
                toggle
                .setDisabled(settingsBlocked || !!warningReason || this.settingsActionInFlight)
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    toggle.setDisabled(true);
                    await this.runSettingsAction(() => this.plugin.setLoggingEnabled(value));
                    this.redisplayIfVisible('logging');
                });
            });

        new Setting(diagnostics)
            .setName('Dry Run Delivery Setup')
            .setDesc('Validate this draft without saving it or sending a network request. The notice omits topic, URL, vault path, title, and body.')
            .addButton(button => {
                this.registerSettingsControl(button);
                button
                .setButtonText('Dry Run')
                .setDisabled(settingsBlocked || this.settingsActionInFlight)
                .onClick(() => {
                    logger.flow('SettingsUI', 'dry-run:start');
                    try {
                        const diagnostic = this.plugin.validateTransportSettingsDraft({ ...draft });
                        logger.flow('SettingsUI', 'dry-run:done', {
                            serverHost: diagnostic.serverHost,
                            secure: diagnostic.secure,
                        });
                        new Notice(this.plugin.diagnosticNotice(diagnostic));
                    } catch (error) {
                        this.logSettingsUiError('dry-run:failed', error);
                        new Notice(getManualComposerFailureMessage(error));
                    }
                });
            });

        if (this.plugin.settings.enabled) {
            const composer = createCollapsibleSection(
                diagnostics,
                'Test Notification',
                this.transportDraftDirty
                    ? 'Send through the prior applied transport; the unsaved draft is not used.'
                    : 'Send one real message through the active transport.',
            );
            new Setting(composer)
                .setName('Send Test Notification')
                .setDesc('Reports accepted only after ntfy returns a correlated message receipt.')
                .addButton(button => {
                    this.testSendButton = button;
                    button
                    .setButtonText(this.testSendInFlight ? 'Sending...' : 'Send Test')
                    .setDisabled(this.testSendInFlight)
                    .onClick(async () => {
                        if (this.testSendInFlight) return;
                        this.testSendInFlight = true;
                        logger.flow('SettingsUI', 'test-send:start');
                        button.setButtonText('Sending...');
                        button.setDisabled(true);
                        try {
                            await this.plugin.sendMessage('Test notification from TPS Notifier', undefined, 'Test Notification');
                            logger.flow('SettingsUI', 'test-send:done');
                            if (this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) {
                                new Notice('Test notification accepted by ntfy.');
                            }
                        } catch (error) {
                            if (this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) {
                                new Notice(getManualComposerFailureMessage(error));
                            }
                        } finally {
                            this.testSendInFlight = false;
                            this.testSendButton?.setButtonText('Send Test');
                            this.testSendButton?.setDisabled(
                                this.settingsActionInFlight || !this.plugin.settings.enabled,
                            );
                        }
                    });
                });
        }
        this.restoreSettingsViewState(containerEl);
    }

    hide(): void {
        this.isTabVisible = false;
        if (!this.transportCommitInFlight) this.resetTransportDraft(true);
        super.hide();
    }

    private updateTransportDirtyState(): void {
        if (!this.transportDraft || this.transportCommitInFlight) return;
        this.transportDraftDirty = this.transportDraft.ntfyServer.trim() !== this.plugin.settings.ntfyServer
            || this.transportDraft.ntfyTopic.trim() !== this.plugin.settings.ntfyTopic
            || this.transportDraft.ntfyPriority !== this.plugin.settings.ntfyPriority;
        this.plugin.setTransportConfigurationDirty(this.transportDraftDirty);
        const blocked = !!this.plugin.getSettingsWriteBlockedReason();
        this.deliveryToggle?.setDisabled(blocked
            || !!this.plugin.getSettingsWarningReason()
            || this.settingsActionInFlight
            || this.transportCommitInFlight
            || (!this.plugin.settings.enabled && this.transportDraftDirty));
        this.applyTransportButton?.setDisabled(blocked
            || this.settingsActionInFlight
            || (!this.transportDraftDirty && !this.plugin.getSettingsWarningReason()));
        this.discardTransportButton?.setDisabled(this.settingsActionInFlight || !this.transportDraftDirty);
        this.applyTransportSetting?.setDesc(this.transportDescription());
    }

    private transportDescription(): string {
        if (this.transportCommitInFlight) {
            return 'Saving this transport configuration. Its controls are locked until the transaction finishes.';
        }
        if (this.transportDraftDirty) {
            return 'The active transport still uses the prior applied target. Apply this complete draft, or discard it.';
        }
        if (this.plugin.getSettingsWarningReason()) {
            return 'Explicitly apply this repaired transport configuration before enabling delivery.';
        }
        return 'The displayed transport configuration is active and durable.';
    }

    private resetTransportDraft(notifyDiscard: boolean): void {
        const hadDirtyDraft = this.transportDraftDirty;
        this.transportDraft = {
            ntfyServer: this.plugin.settings.ntfyServer,
            ntfyTopic: this.plugin.settings.ntfyTopic,
            ntfyPriority: this.plugin.settings.ntfyPriority,
        };
        this.transportDraftDirty = false;
        this.plugin.setTransportConfigurationDirty(false);
        this.applyTransportButton = null;
        this.discardTransportButton = null;
        this.applyTransportSetting = null;
        if (notifyDiscard && hadDirtyDraft && this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) {
            new Notice('Unsaved ntfy transport draft discarded.');
        }
    }

    private async runSettingsAction(action: () => Promise<void>): Promise<boolean> {
        if (this.settingsActionInFlight) {
            if (this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) {
                new Notice('Another TPS Notifier settings change is still saving.');
            }
            return false;
        }
        this.settingsActionInFlight = true;
        this.setSettingsControlsDisabled(true);
        try {
            await action();
            return true;
        } catch (error) {
            const message = isNotifierError(error)
                ? error.message
                : 'TPS Notifier could not save settings. The requested change was not activated; try again.';
            if (this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) new Notice(message);
            return false;
        } finally {
            this.settingsActionInFlight = false;
        }
    }

    private logSettingsUiError(
        event: string,
        error: unknown,
        data?: Record<string, unknown>,
    ): void {
        if (isNotifierError(error)) {
            logger.flowWarn('SettingsUI', event, { ...(data || {}), code: error.code });
        } else {
            logger.flowError('SettingsUI', event, error, data);
        }
    }

    private registerSettingsControl<T extends DisableableControl>(control: T): T {
        this.settingsControls.add(control);
        if (this.settingsActionInFlight) control.setDisabled(true);
        return control;
    }

    private setSettingsControlsDisabled(disabled: boolean): void {
        for (const control of this.settingsControls) control.setDisabled(disabled);
    }

    private redisplayIfVisible(focusKey?: string): void {
        if (!this.isTabVisible || !this.plugin.isReadyForUiFeedback(this.uiLifecycleToken)) return;
        this.display();
        if (!focusKey) return;
        this.containerEl
            .querySelector<HTMLElement>(`[data-tps-notifier-focus="${focusKey}"]`)
            ?.focus();
    }

    private captureSettingsViewState(containerEl: HTMLElement): void {
        this.settingsScrollTop = containerEl.scrollTop;
        this.settingsViewState.clear();
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            this.settingsViewState.set(`${index}:${summaryText}`, details.open);
        });
    }

    private restoreSettingsViewState(containerEl: HTMLElement): void {
        const detailsEls = Array.from(containerEl.querySelectorAll('details'));
        if (!this.hasRenderedSettings) {
            detailsEls.forEach((detailsEl) => {
                (detailsEl as HTMLDetailsElement).removeAttribute('open');
            });
            this.hasRenderedSettings = true;
            containerEl.scrollTop = 0;
            return;
        }
        detailsEls.forEach((detailsEl, index) => {
            const details = detailsEl as HTMLDetailsElement;
            const summaryText = details.querySelector('summary')?.textContent?.trim() || '';
            const isOpen = this.settingsViewState.get(`${index}:${summaryText}`);
            if (isOpen) details.setAttr('open', 'true');
            else details.removeAttribute('open');
        });
        containerEl.scrollTop = this.settingsScrollTop;
    }
}
