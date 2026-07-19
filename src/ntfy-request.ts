import { NotifierError } from './notifier-errors';
import { validateNtfyTarget } from './ntfy-url';

export { buildNtfyUrl, validateNtfyTarget } from './ntfy-url';

export const NTFY_MAX_MESSAGE_BYTES = 4096;
export const NTFY_MAX_TITLE_BYTES = 512;
export const NTFY_MAX_CLICK_CHARACTERS = 4096;

export interface PreparedNotifierRequest {
    readonly url: string;
    readonly method: 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    readonly throw: false;
}

const hasHeaderControls = (value: string): boolean => /[\u0000-\u001F\u007F-\u009F]/.test(value);

const encodeBase64 = (bytes: Uint8Array): string => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (let index = 0; index < bytes.length; index += 3) {
        const first = bytes[index];
        const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
        const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
        const value = (first << 16) | (second << 8) | third;
        output += alphabet[(value >>> 18) & 63];
        output += alphabet[(value >>> 12) & 63];
        output += index + 1 < bytes.length ? alphabet[(value >>> 6) & 63] : '=';
        output += index + 2 < bytes.length ? alphabet[value & 63] : '=';
    }
    return output;
};

export const prepareNtfyTitle = (value: unknown): string => {
    if (value !== undefined && typeof value !== 'string') {
        throw new NotifierError('invalid-payload', 'Notification title must be text.');
    }
    if (typeof value === 'string' && hasHeaderControls(value)) {
        throw new NotifierError('invalid-payload', 'Notification title contains unsupported control characters.');
    }
    const title = typeof value === 'string' && value.trim() ? value.trim() : 'TPS Notifier';
    const titleBytes = new TextEncoder().encode(title);
    if (titleBytes.byteLength > NTFY_MAX_TITLE_BYTES) {
        throw new NotifierError(
            'invalid-payload',
            `Notification title exceeds the ${NTFY_MAX_TITLE_BYTES}-byte safety limit.`,
        );
    }
    if (/[^\x20-\x7E]/.test(title)) {
        const chunks: string[] = [];
        let chunk = '';
        let chunkBytes = 0;
        for (const character of title) {
            const bytes = new TextEncoder().encode(character).byteLength;
            if (chunk && chunkBytes + bytes > 45) {
                chunks.push(`=?UTF-8?B?${encodeBase64(new TextEncoder().encode(chunk))}?=`);
                chunk = '';
                chunkBytes = 0;
            }
            chunk += character;
            chunkBytes += bytes;
        }
        if (chunk) chunks.push(`=?UTF-8?B?${encodeBase64(new TextEncoder().encode(chunk))}?=`);
        return chunks.join(' ');
    }
    return title;
};

export const prepareNotifierRequest = (
    settings: {
        enabled: boolean;
        ntfyServer: string;
        ntfyTopic: string;
        ntfyPriority: number;
    },
    text: unknown,
    title?: unknown,
    clickLink?: unknown,
): PreparedNotifierRequest => {
    if (settings.enabled !== true) {
        throw new NotifierError(
            'delivery-disabled',
            'TPS Notifier delivery is disabled in settings. Enable delivery transport before trying again.',
        );
    }

    const target = validateNtfyTarget(settings.ntfyServer, settings.ntfyTopic);
    if (!target.ok) {
        throw new NotifierError(
            'invalid-configuration',
            'Configure an HTTP(S) ntfy server without embedded credentials, query, or fragment, and a 1-64 character topic using letters, numbers, hyphens, or underscores.',
        );
    }
    if (!Number.isInteger(settings.ntfyPriority)
        || settings.ntfyPriority < 1
        || settings.ntfyPriority > 5) {
        throw new NotifierError('invalid-configuration', 'Notification priority must be an integer from 1 to 5.');
    }
    if (typeof text !== 'string') {
        throw new NotifierError('invalid-payload', 'Notification body must be text.');
    }
    const body = text || '(empty message)';
    if (new TextEncoder().encode(body).byteLength > NTFY_MAX_MESSAGE_BYTES) {
        throw new NotifierError(
            'invalid-payload',
            `Notification body exceeds ntfy's ${NTFY_MAX_MESSAGE_BYTES}-byte message limit and would be treated as an attachment.`,
        );
    }
    if (clickLink !== undefined && typeof clickLink !== 'string') {
        throw new NotifierError('invalid-payload', 'Notification click target must be a URL string.');
    }
    if (typeof clickLink === 'string' && hasHeaderControls(clickLink)) {
        throw new NotifierError('invalid-payload', 'Notification click target contains unsupported control characters.');
    }
    if (typeof clickLink === 'string' && clickLink.length > NTFY_MAX_CLICK_CHARACTERS) {
        throw new NotifierError(
            'invalid-payload',
            `Notification click target exceeds the ${NTFY_MAX_CLICK_CHARACTERS}-character safety limit.`,
        );
    }

    const headers: Record<string, string> = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Title': prepareNtfyTitle(title),
        'Priority': String(settings.ntfyPriority),
        'Markdown': 'yes',
    };

    if (typeof clickLink === 'string' && clickLink) {
        headers['Click'] = clickLink;
    }

    return Object.freeze({
        url: target.url,
        method: 'POST',
        headers: Object.freeze(headers),
        body,
        throw: false,
    });
};
