import { Notice, Plugin, TFile, requestUrl, type Events } from 'obsidian';
import * as logger from './logger';
import { NotifierDiagnostic, TPSNotifierSettings, TransportSettingsDraft } from './types';
import { TPSNotifierSettingTab } from './settings-tab';
import { buildNtfyUrl, validateNtfyTarget } from './ntfy-url';
import { prepareNotifierRequest, type PreparedNotifierRequest } from './ntfy-request';
import { getManualComposerFailureMessage } from './manual-composer';
import { ManualComposerModal } from './manual-composer-modal';
import {
    classifyNotifierSettingsVersion,
    DEFAULT_SETTINGS,
    hasInvalidEnabledTransport,
    hasMalformedNotifierSettingsFields,
    sanitizeNotifierSettings,
} from './settings-migration';
import { normalizeNotifierProtocolPath, sanitizeNotifierDeliveryError, summarizeNotifierTarget } from './notifier-safety';
import { isNotifierError, normalizeLocalNotifierError, NotifierError } from './notifier-errors';
import { executeNotifierDelivery, type NotifierDeliveryReceipt } from './notifier-delivery';
import { RecoverableSerialTaskQueue } from './serial-task-queue';
import { ClosableTaskPool, TaskPoolCapacityError } from './closable-task-pool';
import {
    parseTPSNotifierServiceRequest,
    TPS_NOTIFIER_PROVIDER_PLUGIN_ID,
    TPS_NOTIFIER_SERVICE_EVENTS,
    TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION,
    type TPSNotifierApi,
    type TPSNotifierServiceDescriptor,
} from './tps-notifier-contract';

type NotifierLifecycleState = 'loading' | 'ready' | 'failed' | 'disposed';

const MAX_CONCURRENT_DELIVERIES = 4;
const MAX_PENDING_DELIVERIES = 100;
const SETTINGS_QUEUE_IDLE_TIMEOUT_MS = 15_000;

export default class TPSNotifier extends Plugin {
    private settingsSnapshot = Object.freeze({ ...DEFAULT_SETTINGS }) as Readonly<TPSNotifierSettings>;
    private exposedApi?: Readonly<TPSNotifierApi<TFile>>;
    private serviceDescriptor?: Readonly<TPSNotifierServiceDescriptor<TFile>>;
    private lifecycleState: NotifierLifecycleState = 'loading';
    private lifecycleEpoch = 0;
    private deliveryConfigurationEpoch = 0;
    private settingsWriteBlockedReason = '';
    private settingsWarningReason = '';
    private settingsQueue = new RecoverableSerialTaskQueue();
    private deliveryPool = new ClosableTaskPool(MAX_CONCURRENT_DELIVERIES, MAX_PENDING_DELIVERIES);
    private transportConfigurationDirty = false;
    private readonly deliveryPauseTokens = new Set<symbol>();
    private readonly manualComposerModals = new Set<ManualComposerModal>();

    get settings(): Readonly<TPSNotifierSettings> {
        return this.settingsSnapshot;
    }

    get api(): Readonly<TPSNotifierApi<TFile>> | undefined {
        return this.exposedApi;
    }

    async onload(): Promise<void> {
        const restartError = new NotifierError('not-ready', 'TPS Notifier is restarting.');
        const previousSettingsQueue = this.settingsQueue;
        previousSettingsQueue.close(restartError);
        this.deliveryPool.close(restartError);
        this.lifecycleEpoch += 1;
        this.deliveryConfigurationEpoch += 1;
        const loadEpoch = this.lifecycleEpoch;
        this.lifecycleState = 'loading';
        const previousDescriptor = this.serviceDescriptor;
        this.serviceDescriptor = undefined;
        this.exposedApi = undefined;
        this.announceServiceUnavailable(previousDescriptor);
        logger.setLoggingEnabled(false);

        try {
            await this.waitForPreviousSettingsQueue(previousSettingsQueue);
            this.assertCurrentLoad(loadEpoch);
            this.settingsQueue = new RecoverableSerialTaskQueue();
            this.deliveryPool = new ClosableTaskPool(MAX_CONCURRENT_DELIVERIES, MAX_PENDING_DELIVERIES);
            this.deliveryPauseTokens.clear();
            this.transportConfigurationDirty = false;
            this.settingsWriteBlockedReason = '';
            this.settingsWarningReason = '';
            logger.flow('Plugin', 'load:start');

            await this.loadSettings(loadEpoch);
            this.assertCurrentLoad(loadEpoch);
            logger.flow('Plugin', 'settings:loaded', {
                enabled: this.settings.enabled === true,
                manualComposer: this.settings.enableManualComposer,
                hasTopic: !!this.settings.ntfyTopic,
                priority: this.settings.ntfyPriority,
            });

            this.addCommand({
                id: 'send-custom-notification',
                name: 'Send Custom Notification',
                checkCallback: (checking) => {
                    if (!this.isReadyForUiFeedback() || !this.settings.enableManualComposer) return false;
                    if (!checking) {
                        logger.flow('ManualComposer', 'open');
                        this.openSendNotificationModal();
                    }
                    return true;
                },
            });
            this.addCommand({
                id: 'dry-run-notification-delivery',
                name: 'Validate Notification Delivery Setup (Dry Run)',
                callback: () => {
                    try {
                        const diagnostic = this.validateMessage(
                            'Dry run notification from TPS Notifier',
                            undefined,
                            'TPS Notifier Dry Run',
                        );
                        new Notice(this.diagnosticNotice(diagnostic));
                    } catch (error) {
                        this.logExpectedOrUnexpected('Delivery', 'dry-run-command:failed', error);
                        new Notice(getManualComposerFailureMessage(error));
                    }
                },
            });

            this.addSettingTab(new TPSNotifierSettingTab(this.app, this));
            this.registerObsidianProtocolHandler('tps-messager', (params) => {
                void this.handleProtocolOpen(params);
            });
            this.registerObsidianProtocolHandler('tps-notifier', (params) => {
                void this.handleProtocolOpen(params);
            });

            this.assertCurrentLoad(loadEpoch);
            this.lifecycleState = 'ready';
            this.exposeApi();
            this.publishApiService(loadEpoch);
            logger.flow('Plugin', 'load:done');
        } catch (error) {
            if (loadEpoch !== this.lifecycleEpoch || this.lifecycleState !== 'loading') {
                throw isNotifierError(error)
                    ? error
                    : new NotifierError('not-ready', 'TPS Notifier load was interrupted.');
            }
            this.lifecycleState = 'failed';
            const failedDescriptor = this.serviceDescriptor;
            this.serviceDescriptor = undefined;
            this.exposedApi = undefined;
            this.announceServiceUnavailable(failedDescriptor);
            const failedError = new NotifierError('not-ready', 'TPS Notifier failed to load.');
            this.settingsQueue.close(failedError);
            this.deliveryPool.close(failedError);
            this.closeManualComposerModals();
            logger.flowError('Plugin', 'load:failed', new Error('TPS Notifier initialization failed.'));
            new Notice('TPS Notifier failed to load. Check console.');
            throw error;
        }
    }

    onunload(): void {
        this.lifecycleEpoch += 1;
        this.lifecycleState = 'disposed';
        this.transportConfigurationDirty = false;
        this.deliveryPauseTokens.clear();
        const disposedDescriptor = this.serviceDescriptor;
        this.serviceDescriptor = undefined;
        this.exposedApi = undefined;
        this.announceServiceUnavailable(disposedDescriptor);
        const disposedError = new NotifierError('not-ready', 'TPS Notifier unloaded before this operation started.');
        this.settingsQueue.close(disposedError);
        this.deliveryPool.close(disposedError);
        this.closeManualComposerModals();
        logger.flow('Plugin', 'unload');
        logger.setLoggingEnabled(false);
    }

    getUiLifecycleToken(): number {
        return this.lifecycleEpoch;
    }

    isReadyForUiFeedback(expectedLifecycleToken?: number): boolean {
        return this.lifecycleState === 'ready'
            && (expectedLifecycleToken === undefined || expectedLifecycleToken === this.lifecycleEpoch);
    }

    private installSettings(settings: TPSNotifierSettings): void {
        this.settingsSnapshot = Object.freeze({ ...settings }) as Readonly<TPSNotifierSettings>;
        logger.setLoggingEnabled(this.settings.enableLogging);
    }

    private async loadSettings(loadEpoch: number): Promise<void> {
        let data: unknown;
        try {
            data = await this.loadData();
        } catch (error) {
            this.assertCurrentLoad(loadEpoch);
            this.settingsWriteBlockedReason = 'Notifier settings could not be read. Delivery and settings writes are blocked until the plugin reloads successfully.';
            this.installSettings({ ...DEFAULT_SETTINGS });
            logger.flowError('Settings', 'load:failed', new Error('Notifier settings read failed.'));
            new Notice('TPS Notifier could not read its settings. Delivery is disabled; review TPS Notifier settings.');
            return;
        }

        this.assertCurrentLoad(loadEpoch);
        const compatibility = classifyNotifierSettingsVersion(data);
        const malformedFields = hasMalformedNotifierSettingsFields(data);
        if (compatibility === 'future') {
            this.settingsWriteBlockedReason = 'Notifier settings were written by a newer plugin version. Update TPS Notifier before changing or enabling delivery.';
        } else if (compatibility === 'invalid-version') {
            this.settingsWriteBlockedReason = 'Notifier settings have an invalid schema version. Delivery and settings writes are blocked to avoid overwriting unknown data.';
        } else if (compatibility === 'invalid-data') {
            this.settingsWriteBlockedReason = 'Notifier settings data is malformed. Delivery and settings writes are blocked to avoid overwriting unknown data.';
        }
        if (malformedFields) {
            this.settingsWarningReason = 'Saved delivery was disabled because one or more saved setting values are malformed. Review and explicitly apply a valid transport configuration.';
        } else if (hasInvalidEnabledTransport(data)) {
            this.settingsWarningReason = 'Saved delivery was disabled because its ntfy server or topic is outside the supported transport contract. Apply a valid target, then enable delivery again.';
        }
        this.installSettings(sanitizeNotifierSettings(data));
        if (this.settingsWriteBlockedReason) {
            logger.flowWarn('Settings', 'load:version-blocked', { compatibility });
            new Notice('TPS Notifier settings are read-only and delivery is disabled. Review TPS Notifier settings.');
        } else if (this.settingsWarningReason) {
            logger.flowWarn('Settings', 'load:transport-disabled');
            new Notice('TPS Notifier disabled an unsupported or malformed saved delivery target. Review Notifier settings.');
        }
    }

    getSettingsWriteBlockedReason(): string {
        return this.settingsWriteBlockedReason;
    }

    getSettingsWarningReason(): string {
        return this.settingsWarningReason;
    }

    setTransportConfigurationDirty(dirty: boolean): void {
        if (this.transportConfigurationDirty === dirty) return;
        this.transportConfigurationDirty = dirty;
        logger.flow('Settings', dirty ? 'transport-draft:dirty' : 'transport-draft:clean');
    }

    async applyTransportSettings(draft: TransportSettingsDraft): Promise<void> {
        const validation = validateNtfyTarget(draft?.ntfyServer, draft?.ntfyTopic);
        if (!validation.ok || !Number.isInteger(draft?.ntfyPriority)
            || draft.ntfyPriority < 1 || draft.ntfyPriority > 5) {
            throw new NotifierError(
                'invalid-configuration',
                'Use an HTTP(S) ntfy server without embedded credentials, query, or fragment, a 1-64 character topic using letters, numbers, hyphens, or underscores, and priority 1-5.',
            );
        }
        await this.updateSettings({
            ntfyServer: draft.ntfyServer.trim(),
            ntfyTopic: draft.ntfyTopic.trim(),
            ntfyPriority: draft.ntfyPriority,
        }, 'transport-apply');
        if (this.lifecycleState === 'ready') {
            this.settingsWarningReason = '';
            this.setTransportConfigurationDirty(false);
        }
    }

    async setDeliveryEnabled(enabled: boolean): Promise<void> {
        if (enabled && this.settingsWarningReason) {
            throw new NotifierError(
                'invalid-configuration',
                'Explicitly apply a valid ntfy transport configuration before re-enabling delivery.',
            );
        }
        if (enabled && this.transportConfigurationDirty) {
            throw new NotifierError('transport-dirty', 'Apply or discard the ntfy transport draft before enabling delivery.');
        }
        if (enabled && !buildNtfyUrl(this.settings.ntfyServer, this.settings.ntfyTopic)) {
            throw new NotifierError('invalid-configuration', 'Apply a valid ntfy server and topic before enabling delivery.');
        }

        const pauseToken = Symbol('delivery-disable-transition');
        if (!enabled) {
            this.deliveryPauseTokens.add(pauseToken);
            this.deliveryConfigurationEpoch += 1;
            this.deliveryPool.cancelPending(new NotifierError(
                'delivery-invalidated',
                'Queued notification was canceled before delivery because disabling began.',
            ));
        }
        try {
            await this.updateSettings({ enabled }, enabled ? 'delivery-enable' : 'delivery-disable');
        } finally {
            this.deliveryPauseTokens.delete(pauseToken);
        }
    }

    async setManualComposerEnabled(enabled: boolean): Promise<void> {
        await this.updateSettings({ enableManualComposer: enabled }, 'manual-composer-toggle');
    }

    async setLoggingEnabled(enabled: boolean): Promise<void> {
        await this.updateSettings({ enableLogging: enabled }, 'logging-toggle');
    }

    private async updateSettings(
        patch: Partial<TPSNotifierSettings>,
        reason: string,
    ): Promise<void> {
        const epoch = this.lifecycleEpoch;
        this.assertSettingsWritable(epoch);
        this.assertSettingsRepairRoute(reason);
        await this.settingsQueue.run(async () => {
            this.assertSettingsWritable(epoch);
            this.assertSettingsRepairRoute(reason);
            const snapshot = sanitizeNotifierSettings({
                ...this.settings,
                ...patch,
                settingsVersion: DEFAULT_SETTINGS.settingsVersion,
            });
            if (patch.enabled === true && snapshot.enabled !== true) {
                throw new NotifierError('invalid-configuration', 'Delivery cannot be enabled until the ntfy target is valid.');
            }
            logger.flow('Settings', 'save:start', {
                reason,
                enabled: snapshot.enabled,
                manualComposer: snapshot.enableManualComposer,
                hasTopic: !!snapshot.ntfyTopic,
                priority: snapshot.ntfyPriority,
            });
            try {
                await this.saveData({ ...snapshot });
            } catch {
                logger.flowError('Settings', 'save:failed', new Error('Notifier settings save failed.'), { reason });
                throw new NotifierError(
                    'internal-error',
                    'TPS Notifier could not save settings. The requested change was not activated.',
                );
            }
            if (epoch !== this.lifecycleEpoch || this.lifecycleState !== 'ready') return;
            const deliveryConfigurationChanged = snapshot.enabled !== this.settings.enabled
                || snapshot.ntfyServer !== this.settings.ntfyServer
                || snapshot.ntfyTopic !== this.settings.ntfyTopic
                || snapshot.ntfyPriority !== this.settings.ntfyPriority;
            this.installSettings(snapshot);
            if (deliveryConfigurationChanged) {
                this.deliveryConfigurationEpoch += 1;
                this.deliveryPool.cancelPending(new NotifierError(
                    'delivery-invalidated',
                    'Queued notification was canceled before delivery because the active transport changed.',
                ));
            }
            logger.flow('Settings', 'save:done', { reason });
        });
    }

    private async waitForPreviousSettingsQueue(queue: RecoverableSerialTaskQueue): Promise<void> {
        await queue.whenIdle({
            timeoutMs: SETTINGS_QUEUE_IDLE_TIMEOUT_MS,
            timeoutReason: new NotifierError(
                'not-ready',
                'TPS Notifier is still waiting for an earlier settings save. Reload again after it finishes.',
            ),
        });
    }

    private assertCurrentLoad(loadEpoch: number): void {
        if (loadEpoch !== this.lifecycleEpoch || this.lifecycleState !== 'loading') {
            throw new NotifierError('not-ready', 'TPS Notifier load was interrupted.');
        }
    }

    private assertSettingsWritable(epoch: number): void {
        if (epoch !== this.lifecycleEpoch || this.lifecycleState !== 'ready') {
            throw new NotifierError('not-ready', 'TPS Notifier is not ready to change settings.');
        }
        if (this.settingsWriteBlockedReason) {
            throw new NotifierError('settings-read-only', this.settingsWriteBlockedReason);
        }
    }

    private assertSettingsRepairRoute(reason: string): void {
        if (this.settingsWarningReason && reason !== 'transport-apply') {
            throw new NotifierError(
                'invalid-configuration',
                'Explicitly apply a valid ntfy transport configuration before changing other Notifier settings.',
            );
        }
    }

    private exposeApi(): void {
        const exposureEpoch = this.lifecycleEpoch;
        const assertCurrentApi = (): void => {
            if (exposureEpoch !== this.lifecycleEpoch || this.lifecycleState !== 'ready') {
                throw new NotifierError(
                    'not-ready',
                    'This TPS Notifier API instance is no longer active. Resolve the current plugin API again.',
                );
            }
        };
        const capabilities = Object.freeze({
            structuredReceipts: true as const,
            redactedDiagnostics: true as const,
            stableSequenceIds: false as const,
        });
        const api: TPSNotifierApi<TFile> = {
            apiVersion: 2 as const,
            capabilities,
            send: async (request) => {
                assertCurrentApi();
                const values = this.readStructuredApiRequest(request);
                return await this.sendMessage(values.body, values.file, values.title);
            },
            validate: (request) => {
                assertCurrentApi();
                const values = this.readStructuredApiRequest(request);
                return this.validateMessage(values.body, values.file, values.title);
            },
            sendNotification: async (title, body, file) => {
                assertCurrentApi();
                await this.sendMessage(body, file, title);
            },
            sendMessage: async (text, file, title) => {
                assertCurrentApi();
                await this.sendMessage(text, file, title);
            },
            dryRunMessage: (text, file, title) => {
                assertCurrentApi();
                return this.dryRunMessage(text, file, title);
            },
        };
        this.exposedApi = Object.freeze(api);
    }

    private publishApiService(loadEpoch: number): void {
        const api = this.exposedApi;
        if (!api || loadEpoch !== this.lifecycleEpoch || this.lifecycleState !== 'ready') return;
        const descriptor = Object.freeze({
            protocolVersion: TPS_NOTIFIER_SERVICE_PROTOCOL_VERSION,
            providerPluginId: TPS_NOTIFIER_PROVIDER_PLUGIN_ID,
            api,
        }) as Readonly<TPSNotifierServiceDescriptor<TFile>>;
        this.serviceDescriptor = descriptor;
        this.registerEvent((this.app.workspace as Events).on(TPS_NOTIFIER_SERVICE_EVENTS.REQUEST, (...args: unknown[]) => {
            try {
                if (loadEpoch !== this.lifecycleEpoch
                    || this.lifecycleState !== 'ready'
                    || this.serviceDescriptor !== descriptor) return;
                const request = parseTPSNotifierServiceRequest(args[0]);
                if (!request
                    || loadEpoch !== this.lifecycleEpoch
                    || this.lifecycleState !== 'ready'
                    || this.serviceDescriptor !== descriptor) return;
                request.accept(descriptor);
            } catch {
                logger.flowWarn('ApiService', 'request:consumer-rejected', { accepted: false });
            }
        }));
        try {
            this.app.workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.AVAILABLE, descriptor);
        } catch {
            logger.flowWarn('ApiService', 'available:consumer-failed', { serviceStillAvailable: true });
        }
    }

    private announceServiceUnavailable(
        descriptor: Readonly<TPSNotifierServiceDescriptor<TFile>> | undefined,
    ): void {
        if (!descriptor) return;
        try {
            this.app.workspace.trigger(TPS_NOTIFIER_SERVICE_EVENTS.UNAVAILABLE, descriptor);
        } catch {
            logger.flowWarn('ApiService', 'unavailable:consumer-failed', { serviceUnavailable: true });
        }
    }

    private readStructuredApiRequest(request: unknown): {
        body: unknown;
        title: unknown;
        file: unknown;
    } {
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            throw new NotifierError('invalid-payload', 'Notification request must be an object with a text body.');
        }
        const values = request as Record<string, unknown>;
        const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(values, key);
        const unknownKeys = Object.keys(values).filter((key) => key !== 'body' && key !== 'title' && key !== 'file');
        if (unknownKeys.length > 0) {
            throw new NotifierError(
                'invalid-payload',
                'Notification request contains unsupported fields. Use only body, title, and file.',
            );
        }
        if (!hasOwn('body')) {
            throw new NotifierError('invalid-payload', 'Notification request must define its own body field.');
        }
        if (typeof values.body === 'string' && !values.body.trim()) {
            throw new NotifierError(
                'invalid-payload',
                'Structured notification body must contain non-whitespace text.',
            );
        }
        return {
            body: values.body,
            title: hasOwn('title') ? values.title : undefined,
            file: hasOwn('file') ? values.file : undefined,
        };
    }

    private assertReadyForDelivery(expectedConfigurationEpoch?: number): void {
        if (this.lifecycleState !== 'ready') {
            throw new NotifierError('not-ready', 'TPS Notifier is not ready to accept delivery requests.');
        }
        if (this.settingsWriteBlockedReason) {
            throw new NotifierError('settings-read-only', this.settingsWriteBlockedReason);
        }
        if (this.deliveryPauseTokens.size > 0) {
            throw new NotifierError(
                'delivery-disabled',
                'Notification delivery is paused while a disable request is being saved.',
            );
        }
        if (this.settings.enabled !== true) {
            throw new NotifierError(
                'delivery-disabled',
                'TPS Notifier delivery is disabled in settings. Enable delivery transport before trying again.',
            );
        }
        if (expectedConfigurationEpoch !== undefined
            && expectedConfigurationEpoch !== this.deliveryConfigurationEpoch) {
            throw new NotifierError(
                'delivery-invalidated',
                'Queued notification was canceled before delivery because the active transport changed.',
            );
        }
    }

    buildObsidianLink(file?: unknown): string {
        if (file === undefined) return '';
        if (!(file instanceof TFile)) {
            throw new NotifierError('invalid-payload', 'The notification link target must be an active vault file.');
        }
        const current = this.app.vault.getAbstractFileByPath(file.path);
        if (current !== file) {
            throw new NotifierError('invalid-payload', 'The notification link target is no longer an active vault file.');
        }
        const vaultName = encodeURIComponent(this.app.vault.getName());
        const filePath = encodeURIComponent(file.path);
        return `obsidian://tps-messager?vault=${vaultName}&file=${filePath}`;
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
                logger.flowWarn('Protocol', 'open:blocked', { reason: 'vault-mismatch' });
                new Notice('This notification link targets a different vault.');
                return;
            }
            normalizedPath = normalizeNotifierProtocolPath(params.file) || '';
            if (!normalizedPath) {
                logger.flowWarn('Protocol', 'open:blocked', {
                    reason: 'invalid-path',
                    inputLength: typeof params.file === 'string' ? params.file.length : 0,
                    containsPercent: typeof params.file === 'string' && params.file.includes('%'),
                });
                new Notice('TPS Notifier received an invalid vault-relative file link.');
                return;
            }
            const file = this.app.vault.getAbstractFileByPath(normalizedPath);
            if (!(file instanceof TFile)) {
                logger.flowWarn('Protocol', 'open:missing-file', { pathLength: normalizedPath.length });
                new Notice('TPS Notifier could not find the linked file.');
                return;
            }
            const leaf = this.app.workspace.getLeaf(false);
            if (!leaf) throw new Error('No workspace leaf is available.');
            await leaf.openFile(file);
            logger.flow('Protocol', 'open:done', { pathLength: file.path.length });
        } catch (error) {
            void error;
            logger.flowError('Protocol', 'open:failed', new Error('Protocol link open failed.'), {
                hasNormalizedPath: !!normalizedPath,
                hasFile: !!params.file,
            });
            new Notice('TPS Notifier could not open the linked file.');
        }
    }

    async sendMessage(text: unknown, file?: unknown, title?: unknown): Promise<NotifierDeliveryReceipt> {
        this.assertReadyForDelivery();
        logger.flow('Delivery', 'send:start', {
            hasCustomTitle: typeof title === 'string' && !!title.trim(),
            titleLength: typeof title === 'string' ? title.length : 0,
            bodyLength: typeof text === 'string' ? text.length : 0,
            hasFile: file instanceof TFile,
        });
        this.prepareMessageRequest(text, file, title, 'enqueue');
        const configurationEpoch = this.deliveryConfigurationEpoch;

        try {
            return await this.deliveryPool.run(async () => {
                this.assertReadyForDelivery(configurationEpoch);
                const currentRequest = this.prepareMessageRequest(text, file, title, 'execute');
                return await this.executePreparedRequest(currentRequest);
            });
        } catch (error) {
            if (error instanceof TaskPoolCapacityError) {
                throw new NotifierError(
                    'delivery-busy',
                    `TPS Notifier already has ${MAX_PENDING_DELIVERIES} notifications waiting. This notification was not attempted.`,
                );
            }
            throw error;
        }
    }

    private prepareMessageRequest(
        text: unknown,
        file: unknown,
        title: unknown,
        stage: 'enqueue' | 'execute' | 'dry-run',
    ): PreparedNotifierRequest {
        try {
            return prepareNotifierRequest(
                this.settings,
                text,
                title,
                this.buildObsidianLink(file),
            );
        } catch (error) {
            this.logExpectedOrUnexpected('Delivery', 'send:prepare-failed', error, {
                stage,
                enabled: this.settings.enabled === true,
                hasTopic: !!this.settings.ntfyTopic,
                hasServer: !!this.settings.ntfyServer,
            });
            throw normalizeLocalNotifierError(error);
        }
    }

    private async executePreparedRequest(request: PreparedNotifierRequest): Promise<NotifierDeliveryReceipt> {
        const target = summarizeNotifierTarget(request.url);
        logger.flow('Delivery', 'send:request', {
            ...target,
            priority: request.headers.Priority,
            hasClick: !!request.headers.Click,
            bodyLength: request.body.length,
            active: this.deliveryPool.activeCount,
            pending: this.deliveryPool.pendingCount,
        });
        try {
            const receipt = await executeNotifierDelivery(request, async (prepared) => {
                return await requestUrl({
                    ...prepared,
                    headers: { ...prepared.headers },
                    throw: false,
                });
            });
            logger.flow('Delivery', 'send:done', {
                status: receipt.httpStatus,
                hasProviderReceipt: true,
                ...target,
            });
            return receipt;
        } catch (error) {
            const safeError = sanitizeNotifierDeliveryError(error);
            const safeTarget = logger.isLoggingEnabled()
                ? target
                : { secure: target.secure, hasTopic: target.hasTopic };
            logger.flowError('Delivery', 'send:failed', safeError, {
                ...safeTarget,
                code: safeError.code,
                attempted: safeError.attempted,
                deliveryState: safeError.deliveryState,
                duplicateSafeToRetry: safeError.duplicateSafeToRetry,
                httpStatus: safeError.httpStatus,
            });
            throw safeError;
        }
    }

    dryRunMessage(text: unknown, file?: unknown, title?: unknown): PreparedNotifierRequest {
        this.assertReadyForDelivery();
        const request = this.prepareMessageRequest(text, file, title, 'dry-run');
        logger.flow('Delivery', 'dry-run:prepared', {
            ...summarizeNotifierTarget(request.url),
            priority: request.headers.Priority,
            hasClick: !!request.headers.Click,
            bodyLength: request.body.length,
        });
        return request;
    }

    validateMessage(text: unknown, file?: unknown, title?: unknown): NotifierDiagnostic {
        return this.diagnosticFromRequest(this.dryRunMessage(text, file, title));
    }

    validateTransportSettingsDraft(draft: TransportSettingsDraft): NotifierDiagnostic {
        if (this.lifecycleState !== 'ready') {
            throw new NotifierError('not-ready', 'TPS Notifier is not ready to validate delivery settings.');
        }
        if (this.settingsWriteBlockedReason) {
            throw new NotifierError('settings-read-only', this.settingsWriteBlockedReason);
        }
        const request = prepareNotifierRequest({
            enabled: true,
            ntfyServer: draft.ntfyServer,
            ntfyTopic: draft.ntfyTopic,
            ntfyPriority: draft.ntfyPriority,
        }, 'Dry run notification from TPS Notifier', 'TPS Notifier Dry Run');
        return this.diagnosticFromRequest(request);
    }

    diagnosticNotice(diagnostic: NotifierDiagnostic): string {
        return `Dry run valid for ${diagnostic.serverHost} over ${diagnostic.secure ? 'HTTPS' : 'HTTP'}; priority ${diagnostic.priority}; ${diagnostic.bodyBytes} body bytes.`;
    }

    private diagnosticFromRequest(request: PreparedNotifierRequest): NotifierDiagnostic {
        const target = summarizeNotifierTarget(request.url);
        return Object.freeze({
            valid: true as const,
            serverHost: target.serverHost,
            secure: target.secure,
            priority: Number(request.headers.Priority),
            hasClick: !!request.headers.Click,
            bodyBytes: new TextEncoder().encode(request.body).byteLength,
        });
    }

    openSendNotificationModal(): void {
        if (!this.isReadyForUiFeedback() || !this.settings.enableManualComposer) {
            new Notice('Manual composer is not available.');
            return;
        }
        if (this.manualComposerModals.size > 0) {
            new Notice('The notification composer is already open.');
            return;
        }
        const uiLifecycleToken = this.getUiLifecycleToken();
        const modal = new ManualComposerModal(this.app, {
            send: async (body, title) => {
                await this.sendMessage(body, undefined, title);
            },
            canShowResult: () => this.isReadyForUiFeedback(uiLifecycleToken),
            release: (instance) => this.manualComposerModals.delete(instance),
        });
        this.manualComposerModals.add(modal);
        modal.open();
    }

    private closeManualComposerModals(): void {
        for (const modal of Array.from(this.manualComposerModals)) modal.close();
        this.manualComposerModals.clear();
    }

    private logExpectedOrUnexpected(
        scope: string,
        event: string,
        error: unknown,
        data?: Record<string, unknown>,
    ): void {
        if (isNotifierError(error)) {
            logger.flowWarn(scope, event, { ...(data || {}), code: error.code });
        } else {
            logger.flowError(scope, event, error, data);
        }
    }
}
