export type NotifierErrorCode =
    | 'not-ready'
    | 'settings-read-only'
    | 'delivery-disabled'
    | 'delivery-invalidated'
    | 'transport-dirty'
    | 'invalid-configuration'
    | 'invalid-payload'
    | 'internal-error'
    | 'delivery-busy'
    | 'delivery-rejected'
    | 'delivery-unconfirmed';

export type NotifierDeliveryState = 'not-attempted' | 'rejected' | 'unconfirmed';

export class NotifierError extends Error {
    readonly code: NotifierErrorCode;
    readonly attempted: boolean;
    readonly deliveryState: NotifierDeliveryState;
    readonly duplicateSafeToRetry: boolean;
    readonly httpStatus?: number;

    constructor(
        code: NotifierErrorCode,
        message: string,
        attempted = false,
        deliveryState: NotifierDeliveryState = 'not-attempted',
        httpStatus?: number,
    ) {
        super(message);
        this.name = 'NotifierError';
        this.code = code;
        this.attempted = attempted;
        this.deliveryState = deliveryState;
        this.duplicateSafeToRetry = deliveryState !== 'unconfirmed';
        this.httpStatus = httpStatus;
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

export function isNotifierError(error: unknown): error is NotifierError {
    return error instanceof NotifierError;
}

export function unconfirmedDeliveryError(httpStatus?: number): NotifierError {
    const statusText = typeof httpStatus === 'number' ? ` (HTTP ${httpStatus})` : '';
    return new NotifierError(
        'delivery-unconfirmed',
        `Notification delivery was not confirmed${statusText}. Check ntfy before retrying to avoid a duplicate.`,
        true,
        'unconfirmed',
        httpStatus,
    );
}

export function rejectedDeliveryError(httpStatus: number): NotifierError {
    return new NotifierError(
        'delivery-rejected',
        `ntfy rejected the notification (HTTP ${httpStatus}). Correct the delivery configuration or payload before retrying.`,
        true,
        'rejected',
        httpStatus,
    );
}

export function normalizeLocalNotifierError(error: unknown): NotifierError {
    if (isNotifierError(error)) return error;
    return new NotifierError(
        'internal-error',
        'TPS Notifier encountered an unexpected local error before delivery.',
    );
}
