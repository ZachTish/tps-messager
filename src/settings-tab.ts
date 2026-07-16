import { App, Notice, PluginSettingTab, Setting, debounce } from 'obsidian';
import type TPSNotifier from './main';
import { getManualComposerFailureMessage } from './manual-composer';
import * as logger from './logger';
import { summarizeNotifierTarget } from './notifier-safety';

const createCollapsibleSection = (
    parent: HTMLElement,
    title: string,
    description?: string,
    defaultOpen = false
): HTMLElement => {
    const details = parent.createEl('details', { cls: 'tps-collapsible-section' });
    if (defaultOpen) {
        details.setAttr('open', 'true');
    }

    const summary = details.createEl('summary', { cls: 'tps-collapsible-section-summary' });
    summary.createSpan({ cls: 'tps-collapsible-section-title', text: title });

    if (description) {
        details.createEl('p', {
            cls: 'tps-collapsible-section-description',
            text: description
        });
    }

    return details.createDiv({ cls: 'tps-collapsible-section-content' });
};

export class TPSNotifierSettingTab extends PluginSettingTab {
    plugin: TPSNotifier;
    private settingsViewState = new Map<string, boolean>();
    private settingsScrollTop = 0;
    private hasRenderedSettings = false;

    constructor(app: App, plugin: TPSNotifier) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        this.captureSettingsViewState(containerEl);
        containerEl.empty();

        const debouncedSave = debounce(() => this.plugin.saveSettings(), 300);

        containerEl.createEl('h2', { text: 'TPS Notifier Settings' });
        containerEl.createEl('p', {
            text: 'Keep this plugin focused on transport settings. TPS Controller can use it for reminder delivery once connection is configured.',
            cls: 'setting-item-description'
        });

        const coreSettings = containerEl.createDiv({ cls: 'tps-settings-core' });
        new Setting(coreSettings).setName('Core settings').setHeading();

        const delivery = coreSettings;

        new Setting(delivery)
            .setName('Enable delivery transport')
            .setDesc('Master toggle for outbound notification delivery.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled === true)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        const connection = coreSettings;

        if (this.plugin.settings.enabled === true) {
            new Setting(connection)
                .setName('ntfy Server')
                .setDesc('The ntfy server URL (e.g., https://ntfy.sh)')
                .addText(text => text
                    .setPlaceholder('https://ntfy.sh')
                    .setValue(this.plugin.settings.ntfyServer)
                    .onChange((value) => {
                        this.plugin.settings.ntfyServer = value;
                        void debouncedSave();
                    }));

            new Setting(connection)
                .setName('ntfy Topic')
                .setDesc('Your unique topic name')
                .addText(text => text
                    .setPlaceholder('my-reminders')
                    .setValue(this.plugin.settings.ntfyTopic)
                    .onChange((value) => {
                        this.plugin.settings.ntfyTopic = value;
                        void debouncedSave();
                    }));

            new Setting(connection)
                .setName('Priority')
                .setDesc('Notification priority (1-5)')
                .addSlider(slider => slider
                    .setLimits(1, 5, 1)
                    .setValue(this.plugin.settings.ntfyPriority)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.ntfyPriority = value;
                        await this.plugin.saveSettings();
                    }));
        } else {
            connection.createEl('p', {
                text: 'Delivery transport is disabled. Enable it above to configure server/topic settings.',
                cls: 'setting-item-description'
            });
        }

        const diagnostics = createCollapsibleSection(
            containerEl,
            'Manual Composer, Logging, and Delivery Test',
            'Optional tools for verifying delivery and troubleshooting.',
            false
        );

        new Setting(diagnostics)
            .setName('Enable manual composer command')
            .setDesc('Registers the “Send Custom Notification” command in the command palette.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableManualComposer ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enableManualComposer = value;
                    await this.plugin.saveSettings();
                    this.display();
                }));

        new Setting(diagnostics)
            .setName('Enable Logging')
            .setDesc('Log detailed info to console')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    logger.flow('SettingsUI', 'logging-toggle', { enabled: value });
                    await this.plugin.saveSettings();
                }));

        new Setting(diagnostics)
            .setName('Dry Run Delivery Setup')
            .setDesc('Validate the ntfy URL, headers, priority, and fallback body without sending a network request.')
            .addButton(button => button
                .setButtonText('Dry Run')
                .onClick(() => {
                    logger.flow('SettingsUI', 'dry-run:start');
                    try {
                        const request = this.plugin.dryRunMessage(
                            'Dry run notification from TPS Notifier',
                            undefined,
                            'TPS Notifier Dry Run',
                        );
                        logger.flow('SettingsUI', 'dry-run:done', { ...summarizeNotifierTarget(request.url) });
                        new Notice(`Dry run prepared: ${request.url}`);
                    } catch (e) {
                        logger.flowError('SettingsUI', 'dry-run:failed', e);
                        new Notice(getManualComposerFailureMessage(e));
                    }
                }));

        if (this.plugin.settings.enabled === true && (this.plugin.settings.enableManualComposer ?? true)) {
            const composer = createCollapsibleSection(
                diagnostics,
                'Test Notification',
                'Command and test payload tooling for manual sends.',
                false
            );

            new Setting(composer)
                .setName('Send Test Notification')
                .setDesc('Send a test notification to verify connection')
                .addButton(button => button
                    .setButtonText('Send Test')
                    .onClick(async () => {
                        logger.flow('SettingsUI', 'test-send:start');
                        button.setButtonText('Sending...');
                        button.setDisabled(true);
                        try {
                            await this.plugin.sendMessage('Test notification from TPS Notifier', undefined, 'Test Notification');
                            logger.flow('SettingsUI', 'test-send:done');
                            new Notice('Test notification sent!');
                        } catch (e) {
                            logger.flowError('SettingsUI', 'test-send:failed', e);
                            new Notice(getManualComposerFailureMessage(e));
                        }
                        button.setButtonText('Send Test');
                        button.setDisabled(false);
                    }));
        }
        this.restoreSettingsViewState(containerEl);
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
