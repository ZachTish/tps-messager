import type { TPSNotifierSettings } from './types';

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
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(5, Math.max(1, Math.round(value)))
        : fallback;
};

export const sanitizeNotifierSettings = (data: unknown): TPSNotifierSettings => {
    const raw = asRecord(data);
    return {
        settingsVersion: NOTIFIER_SETTINGS_VERSION,
        enabled: asBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
        enableManualComposer: asBoolean(raw.enableManualComposer, DEFAULT_SETTINGS.enableManualComposer),
        ntfyServer: asString(raw.ntfyServer, DEFAULT_SETTINGS.ntfyServer),
        ntfyTopic: asString(raw.ntfyTopic, DEFAULT_SETTINGS.ntfyTopic),
        ntfyPriority: asPriority(raw.ntfyPriority, DEFAULT_SETTINGS.ntfyPriority),
        enableLogging: asBoolean(raw.enableLogging, DEFAULT_SETTINGS.enableLogging),
    };
};
