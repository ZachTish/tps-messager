import type { TPSNotifierSettings } from './types';
import { buildNtfyUrl } from './ntfy-url';

export const NOTIFIER_SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS: TPSNotifierSettings = {
    settingsVersion: NOTIFIER_SETTINGS_VERSION,
    enabled: false,
    enableManualComposer: true,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyPriority: 3,
    enableLogging: false,
};

const asRecord = (value: unknown): Record<string, unknown> => {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

const asBoolean = (value: unknown, fallback: boolean): boolean => {
    return typeof value === 'boolean' ? value : fallback;
};

const asString = (value: unknown, fallback: string): string => {
    return typeof value === 'string' ? value : fallback;
};

const asPriority = (value: unknown, fallback: number): number => {
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5
        ? value as number
        : fallback;
};

const hasOwn = (value: Record<string, unknown>, key: string): boolean => (
    Object.prototype.hasOwnProperty.call(value, key)
);

export type NotifierSettingsCompatibility = 'legacy' | 'current' | 'future' | 'invalid-version' | 'invalid-data';

export const classifyNotifierSettingsVersion = (data: unknown): NotifierSettingsCompatibility => {
    if (data !== null && data !== undefined
        && (typeof data !== 'object' || Array.isArray(data))) return 'invalid-data';
    const raw = asRecord(data);
    if (!Object.prototype.hasOwnProperty.call(raw, 'settingsVersion')) return 'legacy';
    if (!Number.isInteger(raw.settingsVersion) || (raw.settingsVersion as number) < 1) {
        return 'invalid-version';
    }
    if ((raw.settingsVersion as number) > NOTIFIER_SETTINGS_VERSION) return 'future';
    return 'current';
};

export const hasMalformedNotifierSettingsFields = (data: unknown): boolean => {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    const raw = data as Record<string, unknown>;
    const requiredCurrentFields = [
        'enabled',
        'enableManualComposer',
        'ntfyServer',
        'ntfyTopic',
        'ntfyPriority',
        'enableLogging',
    ];
    const currentDocumentIsIncomplete = raw.settingsVersion === NOTIFIER_SETTINGS_VERSION
        && requiredCurrentFields.some((field) => !hasOwn(raw, field));
    return currentDocumentIsIncomplete
        || (hasOwn(raw, 'enabled') && typeof raw.enabled !== 'boolean')
        || (hasOwn(raw, 'enableManualComposer') && typeof raw.enableManualComposer !== 'boolean')
        || (hasOwn(raw, 'ntfyServer') && typeof raw.ntfyServer !== 'string')
        || (hasOwn(raw, 'ntfyTopic') && typeof raw.ntfyTopic !== 'string')
        || (hasOwn(raw, 'ntfyPriority')
            && (!Number.isInteger(raw.ntfyPriority)
                || (raw.ntfyPriority as number) < 1
                || (raw.ntfyPriority as number) > 5))
        || (hasOwn(raw, 'enableLogging') && typeof raw.enableLogging !== 'boolean');
};

export const hasInvalidEnabledTransport = (data: unknown): boolean => {
    const raw = asRecord(data);
    if (raw.enabled !== true) return false;
    const compatibility = classifyNotifierSettingsVersion(data);
    if (compatibility === 'future'
        || compatibility === 'invalid-version'
        || compatibility === 'invalid-data') return false;
    return typeof raw.ntfyServer !== 'string'
        || typeof raw.ntfyTopic !== 'string'
        || buildNtfyUrl(raw.ntfyServer.trim(), raw.ntfyTopic.trim()) === null;
};

export const sanitizeNotifierSettings = (data: unknown): TPSNotifierSettings => {
    const raw = asRecord(data);
    const serverWasString = typeof raw.ntfyServer === 'string';
    const topicWasString = typeof raw.ntfyTopic === 'string';
    const canUseDefaultPublicServer = !hasOwn(raw, 'ntfyServer') && !hasOwn(raw, 'ntfyTopic');
    const ntfyServer = serverWasString
        ? (raw.ntfyServer as string).trim()
        : canUseDefaultPublicServer ? DEFAULT_SETTINGS.ntfyServer : '';
    const ntfyTopic = asString(raw.ntfyTopic, DEFAULT_SETTINGS.ntfyTopic).trim();
    const compatibility = classifyNotifierSettingsVersion(data);
    const malformedFields = hasMalformedNotifierSettingsFields(data);
    const transportIsExplicitlyValid = serverWasString
        && topicWasString
        && buildNtfyUrl(ntfyServer, ntfyTopic) !== null;
    return {
        settingsVersion: NOTIFIER_SETTINGS_VERSION,
        enabled: asBoolean(raw.enabled, DEFAULT_SETTINGS.enabled)
            && compatibility !== 'future'
            && compatibility !== 'invalid-version'
            && compatibility !== 'invalid-data'
            && !malformedFields
            && transportIsExplicitlyValid,
        enableManualComposer: asBoolean(raw.enableManualComposer, DEFAULT_SETTINGS.enableManualComposer),
        ntfyServer,
        ntfyTopic,
        ntfyPriority: asPriority(raw.ntfyPriority, DEFAULT_SETTINGS.ntfyPriority),
        enableLogging: asBoolean(raw.enableLogging, DEFAULT_SETTINGS.enableLogging),
    };
};
