export interface NotifierTargetSummary {
    serverHost: string;
    secure: boolean;
    hasTopic: boolean;
}

export function normalizeNotifierProtocolPath(value: unknown): string | null {
    const path = typeof value === 'string' ? value.replace(/\\/g, '/') : '';
    if (!path || path.startsWith('/') || path.includes('\0')) return null;
    const segments = path.split('/');
    if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
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

export function sanitizeNotifierDeliveryError(error: unknown, requestUrl: string): Error {
    const original = error instanceof Error ? error : new Error(String(error || 'Notification delivery failed.'));
    let message = original.message || 'Notification delivery failed.';
    try {
        const parsed = new URL(requestUrl);
        const pathSegments = parsed.pathname.split('/').filter(Boolean);
        const topic = decodeURIComponent(pathSegments[pathSegments.length - 1] || '');
        for (const sensitive of new Set([topic, encodeURIComponent(topic)])) {
            if (sensitive) message = message.split(sensitive).join('[redacted]');
        }
        message = message.replace(/https?:\/\/[^\s"'<>]+/gi, candidate => {
            try {
                const candidateUrl = new URL(candidate);
                return `${candidateUrl.protocol}//${candidateUrl.host}/[redacted]`;
            } catch {
                return '[redacted-url]';
            }
        });
    } catch {
        // Request preparation already validates URLs; retain the compact message if parsing still fails.
    }
    const sanitized = new Error(message);
    sanitized.name = original.name;
    return sanitized;
}
