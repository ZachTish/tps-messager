import { nativeSettingsSearch, focusSettingsSearchResult, type SettingsSearchEntry } from "./native-settings-search";
import { SETTINGS_SEARCH_ENTRIES, SETTINGS_SEARCH_ROUTES } from "./settings-search-catalog";
import { App, Notice, PluginSettingTab, Setting } from 'obsidian';
import type TPSNotifier from './main';
import { getManualComposerFailureMessage } from './manual-composer';
import * as logger from './logger';
import { summarizeNotifierTarget } from './notifier-safety';

type NotifierSettingsRoute = 'delivery' | 'composer' | 'diagnostics';

const NOTIFIER_SETTINGS_ROUTES: Array<{
    id: NotifierSettingsRoute;
    title: string;
    description: string;
}> = [
    {
        id: 'delivery',
        title: 'Delivery',
        description: 'Connect ntfy and choose the delivery priority.',
    },
    {
        id: 'composer',
        title: 'Composer',
        description: 'Enable manual sends and verify the connection.',
    },
    {
        id: 'diagnostics',
        title: 'Diagnostics',
        description: 'Control logging and validate a request without sending it.',
    },
];

export class TPSNotifierSettingTab extends PluginSettingTab {
  private searchContentEl: HTMLElement | null = null;
  private get settingsContentEl(): HTMLElement {
    return this.searchContentEl?.isConnected ? this.searchContentEl : this.containerEl;
  }

  getSettingDefinitions() {
    return nativeSettingsSearch(SETTINGS_SEARCH_ENTRIES, SETTINGS_SEARCH_ROUTES,
      container => {
        this.searchContentEl = container;
        this.display();
        return () => { this.hide(); if (this.searchContentEl === container) this.searchContentEl = null; };
      }, entry => this.openSearchResult(entry));
  }

  private openSearchResult(entry: SettingsSearchEntry): void {
    this.activeRoute = entry.route as NotifierSettingsRoute;
    const manager = (this.app as App & { setting?: { openTabById?: (id: string) => void } }).setting;
    manager?.openTabById?.(this.plugin.manifest.id);
    this.display();
    if (!focusSettingsSearchResult(this.settingsContentEl, entry.name)) {
      const message = this.settingsContentEl.createDiv({
        text: `“${entry.name}” is in this area. Its control appears when the relevant feature or saved item is selected.`,
        attr: { role: 'status', tabindex: '-1' },
      });
      this.settingsContentEl.prepend(message);
      message.focus();
      message.scrollIntoView({ block: 'start' });
    }
  }

    plugin: TPSNotifier;
    private activeRoute: NotifierSettingsRoute = 'delivery';

    constructor(app: App, plugin: TPSNotifier) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        this.renderSettings();
    }

    private renderSettings(focusRouteHeading = false, focusControlName?: string): void {
        const containerEl = this.settingsContentEl;
        const scrollTop = containerEl.scrollTop;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'TPS Notifier Settings' });

        const routeHub = containerEl.createDiv({ cls: 'tps-notifier-settings-hub' });
        routeHub.createEl('h3', { text: 'Choose what to configure' });

        const routeNav = routeHub.createDiv({
            cls: 'tps-notifier-settings-routes',
            attr: { role: 'navigation', 'aria-label': 'Notifier settings destinations' },
        });
        let activeRouteButton: HTMLButtonElement | null = null;
        for (const route of NOTIFIER_SETTINGS_ROUTES) {
            const isActive = route.id === this.activeRoute;
            const button = routeNav.createEl('button', {
                cls: `tps-notifier-settings-route${isActive ? ' is-active' : ''}`,
                attr: {
                    type: 'button',
                    'aria-pressed': String(isActive),
                    'aria-label': route.title,
                },
            });
            if (isActive) activeRouteButton = button;
            button.createSpan({ cls: 'tps-notifier-settings-route-title', text: route.title });
            button.addEventListener('click', () => {
                if (this.activeRoute === route.id) return;
                this.activeRoute = route.id;
                this.renderSettings(true);
            });
        }

        const route = NOTIFIER_SETTINGS_ROUTES.find(({ id }) => id === this.activeRoute)
            ?? NOTIFIER_SETTINGS_ROUTES[0];
        const page = containerEl.createDiv({ cls: 'tps-notifier-settings-page' });
        const pageHeading = page.createEl('h3', {
            text: route.title,
            attr: { tabindex: '-1' },
        });

        if (route.id === 'delivery') {
            this.renderDeliverySettings(page);
        } else if (route.id === 'composer') {
            this.renderComposerSettings(page);
        } else {
            this.renderDiagnosticsSettings(page);
        }

        if (!focusRouteHeading) containerEl.scrollTop = scrollTop;
        if (focusRouteHeading || focusControlName) {
            requestAnimationFrame(() => {
                activeRouteButton?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
                if (focusControlName) {
                    const settingItems = Array.from(page.querySelectorAll<HTMLElement>('.setting-item'));
                    const settingItem = settingItems.find((item) =>
                        item.querySelector('.setting-item-name')?.textContent?.trim() === focusControlName
                    );
                    const control = settingItem?.querySelector<HTMLElement>('input, button, select, textarea');
                    control?.focus({ preventScroll: true });
                    return;
                }
                pageHeading.focus({ preventScroll: true });
                pageHeading.scrollIntoView({ block: 'start' });
            });
        }
    }

    private renderDeliverySettings(parent: HTMLElement): void {
        new Setting(parent)
            .setName('Enable delivery transport')
            .setDesc('Master toggle for outbound notification delivery.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enabled === true)
                .onChange(async (value) => {
                    this.plugin.settings.enabled = value;
                    await this.plugin.saveSettings();
                    this.renderSettings(false, 'Enable delivery transport');
                }));

        if (this.plugin.settings.enabled === true) {
            new Setting(parent)
                .setName('ntfy Server')
                .setDesc('The ntfy server URL (e.g., https://ntfy.sh)')
                .addText(text => text
                    .setPlaceholder('https://ntfy.sh')
                    .setValue(this.plugin.settings.ntfyServer)
                    .onChange(async (value) => {
                        this.plugin.settings.ntfyServer = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(parent)
                .setName('ntfy Topic')
                .addText(text => text
                    .setPlaceholder('my-reminders')
                    .setValue(this.plugin.settings.ntfyTopic)
                    .onChange(async (value) => {
                        this.plugin.settings.ntfyTopic = value;
                        await this.plugin.saveSettings();
                    }));

            new Setting(parent)
                .setName('Priority')
                .addSlider(slider => slider
                    .setLimits(1, 5, 1)
                    .setValue(this.plugin.settings.ntfyPriority)
                    .setDynamicTooltip()
                    .onChange(async (value) => {
                        this.plugin.settings.ntfyPriority = value;
                        await this.plugin.saveSettings();
                    }));
        } else {
            parent.createEl('p', {
                text: 'Delivery transport is disabled. Enable it above to configure server/topic settings.',
                cls: 'setting-item-description'
            });
        }
    }

    private renderComposerSettings(parent: HTMLElement): void {
        new Setting(parent)
            .setName('Enable manual composer command')
            .setDesc('Registers the “Send Custom Notification” command in the command palette.')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableManualComposer ?? true)
                .onChange(async (value) => {
                    this.plugin.settings.enableManualComposer = value;
                    await this.plugin.saveSettings();
                    this.renderSettings(false, 'Enable manual composer command');
                }));

        if (this.plugin.settings.enabled === true && (this.plugin.settings.enableManualComposer ?? true)) {
            new Setting(parent)
                .setName('Send Test Notification')
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
        } else {
            parent.createEl('p', {
                text: 'Enable both delivery transport and the manual composer before sending a test notification.',
                cls: 'setting-item-description',
            });
        }
    }

    private renderDiagnosticsSettings(parent: HTMLElement): void {
        new Setting(parent)
            .setName('Enable Logging')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.enableLogging)
                .onChange(async (value) => {
                    this.plugin.settings.enableLogging = value;
                    logger.flow('SettingsUI', 'logging-toggle', { enabled: value });
                    await this.plugin.saveSettings();
                }));

        new Setting(parent)
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
    }
}
