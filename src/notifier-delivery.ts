import type { PreparedNotifierRequest } from './ntfy-request';
import { rejectedDeliveryError, unconfirmedDeliveryError } from './notifier-errors';
import type { TPSNotifierDeliveryReceipt } from './tps-contracts';

export type NotifierDeliveryReceipt = TPSNotifierDeliveryReceipt;

// Conservative subset of documented ntfy server errors reachable from publishing.
// Unknown/future codes remain unconfirmed until deliberately reviewed.
const NTFY_PUBLISH_REJECTION_CODES = new Set([
    40000, 40001, 40002, 40003, 40004, 40005, 40006, 40007,
    40009, 40010, 40011, 40013, 40014, 40015, 40017, 40018,
    40021, 40032, 40033, 40034, 40035, 40037, 40041, 40042,
    40043, 40044, 40045, 40047, 40048, 40049, 40050, 40052,
    40053, 40101, 40301, 40401, 41301, 41303, 42901, 42902,
    42905, 42908, 42910, 42911,
]);

export interface NotifierRequestResponse {
    status: number;
    json?: unknown;
}

export type NotifierRequestExecutor = (
    request: PreparedNotifierRequest,
) => Promise<NotifierRequestResponse>;

function requestTopic(request: PreparedNotifierRequest): string | null {
    try {
        const segments = new URL(request.url).pathname.split('/').filter(Boolean);
        return segments.length > 0 ? segments[segments.length - 1] : null;
    } catch {
        return null;
    }
}

function providerMessageId(
    request: PreparedNotifierRequest,
    response: NotifierRequestResponse,
): string | null {
    let payload: unknown;
    try {
        payload = response.json;
    } catch {
        return null;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const record = payload as Record<string, unknown>;
    if (record.event !== 'message' || record.topic !== requestTopic(request)) return null;
    const id = record.id;
    return typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : null;
}

function isStructuredNtfyRejection(
    response: NotifierRequestResponse,
    status: number,
): boolean {
    if (status < 400 || status >= 500 || status === 408) return false;
    let payload: unknown;
    try {
        payload = response.json;
    } catch {
        return false;
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
    const record = payload as Record<string, unknown>;
    return record.http === status
        && Number.isInteger(record.code)
        && Math.floor((record.code as number) / 100) === status
        && NTFY_PUBLISH_REJECTION_CODES.has(record.code as number)
        && typeof record.error === 'string'
        && record.error.length > 0;
}

export async function executeNotifierDelivery(
    request: PreparedNotifierRequest,
    execute: NotifierRequestExecutor,
): Promise<NotifierDeliveryReceipt> {
    let response: NotifierRequestResponse;
    try {
        response = await execute(request);
    } catch {
        throw unconfirmedDeliveryError();
    }

    const status = Number.isInteger(response.status) ? response.status : undefined;
    if (status == null || status < 200 || status >= 300) {
        if (status != null && isStructuredNtfyRejection(response, status)) {
            throw rejectedDeliveryError(status);
        }
        throw unconfirmedDeliveryError(status);
    }
    const id = providerMessageId(request, response);
    if (!id) throw unconfirmedDeliveryError(status);
    return Object.freeze({
        outcome: 'accepted' as const,
        httpStatus: status,
        providerMessageId: id,
    });
}
