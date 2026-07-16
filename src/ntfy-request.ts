import { buildNtfyUrl } from './ntfy-url';

export interface PreparedNotifierRequest {
    url: string;
    method: 'POST';
    headers: Record<string, string>;
    body: string;
}

export const prepareNotifierRequest = (
    settings: {
        enabled: boolean;
        ntfyServer: string;
        ntfyTopic: string;
        ntfyPriority: number;
    },
    text: string,
    title?: string,
    clickLink?: string,
): PreparedNotifierRequest => {
    if (!settings.enabled) {
        throw new Error('TPS Notifier delivery is disabled in settings.');
    }

    const url = buildNtfyUrl(settings.ntfyServer, settings.ntfyTopic);
    if (!url) {
        throw new Error('Configure ntfy server and topic first.');
    }

    const sanitizedTitle = (title || 'TPS Notifier').replace(/[^\x00-\xFF]/g, '');

    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': sanitizedTitle,
        'Priority': String(settings.ntfyPriority || 3),
        'Markdown': 'yes',
    };

    if (clickLink) {
        headers['Click'] = clickLink;
    }

    return {
        url,
        method: 'POST',
        headers,
        body: text || '(empty message)',
    };
};
