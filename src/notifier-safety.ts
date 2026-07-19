import { isNotifierError, NotifierError, unconfirmedDeliveryError } from './notifier-errors';

export interface NotifierTargetSummary {
    serverHost: string;
    secure: boolean;
    hasTopic: boolean;
}

export function normalizeNotifierProtocolPath(value: unknown): string | null {
    const path = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
    if (!path || path.length > 4096 || path.startsWith('/') || path.includes('\0')) return null;
    const segments = path.split('/');
    if (segments.length > 256
        || segments.some(segment => !segment || segment.length > 255 || segment === '.' || segment === '..')) {
        return null;
    }
    return segments.join('/');
}

export function summarizeNotifierTarget(url: string): NotifierTargetSummary {
    try {
        const parsed = new URL(url);
        return {
            serverHost: parsed.host,
            secure: parsed.protocol === 'https:',
            hasTopic: parsed.pathname.split('/').some(Boolean),
        };
    } catch {
        return { serverHost: '', secure: false, hasTopic: false };
    }
}

export function sanitizeNotifierDeliveryError(error: unknown): NotifierError {
    if (isNotifierError(error)) return error;
    return unconfirmedDeliveryError();
}
