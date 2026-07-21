import type { TPSNotifierSettings } from './types';

export const NOTIFIER_SETTINGS_VERSION = 1;

type SettingsRecord = Record<string, unknown>;

const LEGACY_NOTIFIER_SETTING_KEYS = ["alertState", "reminderRules", "deviceRole"] as const;

export const DEFAULT_SETTINGS: TPSNotifierSettings = {
    settingsVersion: NOTIFIER_SETTINGS_VERSION,
    enabled: false,
    enableManualComposer: true,
    ntfyServer: 'https://ntfy.sh',
    ntfyTopic: '',
    ntfyPriority: 3,
    enableLogging: false,
};

const asRecord = (value: unknown): SettingsRecord => {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as SettingsRecord : {};
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
    const preserved = Object.entries(raw).reduce((result, [key, value]) => {
        result[key] = cloneSettingValue(value);
        return result;
    }, {} as SettingsRecord);
    for (const key of LEGACY_NOTIFIER_SETTING_KEYS) delete preserved[key];
    return Object.assign(preserved, {
        settingsVersion: isFutureNotifierSettings(raw) ? notifierSettingsVersion(raw) : NOTIFIER_SETTINGS_VERSION,
        enabled: asBoolean(raw.enabled, DEFAULT_SETTINGS.enabled),
        enableManualComposer: asBoolean(raw.enableManualComposer, DEFAULT_SETTINGS.enableManualComposer),
        ntfyServer: asString(raw.ntfyServer, DEFAULT_SETTINGS.ntfyServer),
        ntfyTopic: asString(raw.ntfyTopic, DEFAULT_SETTINGS.ntfyTopic),
        ntfyPriority: asPriority(raw.ntfyPriority, DEFAULT_SETTINGS.ntfyPriority),
        enableLogging: asBoolean(raw.enableLogging, DEFAULT_SETTINGS.enableLogging),
    }) as TPSNotifierSettings;
};

export const notifierSettingsVersion = (value: unknown): number => {
    const parsed = Number(asRecord(value).settingsVersion);
    return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
};

export const isFutureNotifierSettings = (value: unknown): boolean => {
    return notifierSettingsVersion(value) > NOTIFIER_SETTINGS_VERSION;
};

export const changedNotifierSettingsKeys = (previous: TPSNotifierSettings | null, next: TPSNotifierSettings): string[] => {
    if (!previous) return Object.keys(next).sort();
    const previousRecord = previous as unknown as SettingsRecord;
    const nextRecord = next as unknown as SettingsRecord;
    const keys = new Set([...Object.keys(previousRecord), ...Object.keys(nextRecord)]);
    return Array.from(keys)
        .filter((key) => stableSettingValue(previousRecord[key]) !== stableSettingValue(nextRecord[key]))
        .sort();
};

export const mergeNotifierSettingsChanges = (
    latestStored: unknown,
    localSettings: TPSNotifierSettings,
    changedKeys: readonly string[],
): TPSNotifierSettings => {
    const merged = sanitizeNotifierSettings(latestStored) as unknown as SettingsRecord;
    const local = localSettings as unknown as SettingsRecord;
    for (const key of changedKeys) {
        if (key === "settingsVersion" || !Object.prototype.hasOwnProperty.call(local, key)) continue;
        merged[key] = cloneSettingValue(local[key]);
    }
    return sanitizeNotifierSettings(merged);
};

const cloneSettingValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(cloneSettingValue);
    if (value && typeof value === "object") {
        return Object.entries(value as SettingsRecord).reduce((result, [key, entryValue]) => {
            result[key] = cloneSettingValue(entryValue);
            return result;
        }, {} as SettingsRecord);
    }
    return value;
};

const stableSettingValue = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableSettingValue).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.entries(value as SettingsRecord)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => `${key}:${stableSettingValue(entryValue)}`)
            .join(",")}}`;
    }
    return JSON.stringify(value);
};
