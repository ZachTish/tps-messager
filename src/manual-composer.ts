import { isNotifierError } from './notifier-errors';

export type ManualComposerSubmitResult = {
    shouldClose: boolean;
    statusText: string;
    noticeText?: string;
};

export function getManualComposerFailureMessage(error: unknown): string {
    if (isNotifierError(error)) {
        if (error.code === 'delivery-disabled') return error.message;
        if (error.code === 'delivery-unconfirmed'
            || error.code === 'delivery-rejected'
            || error.code === 'delivery-busy'
            || error.code === 'delivery-invalidated') return error.message;
        if (error.code === 'not-ready' || error.code === 'internal-error') {
            return `${error.message} Reload TPS Notifier before retrying.`;
        }
        return `${error.message} Correct the issue, then try again.`;
    }

    return 'Notification delivery failed before a result was available. Review the settings and logs before trying again.';
}

export function getManualComposerValidationMessage(title: string, body: string): string | null {
    if (!title.trim() && !body.trim()) {
        return 'Please provide a title or message body.';
    }

    return null;
}

export async function submitManualComposerNotification(
    title: string,
    body: string,
    send: (body: string, title: string) => Promise<void>,
): Promise<ManualComposerSubmitResult> {
    const validationMessage = getManualComposerValidationMessage(title, body);
    if (validationMessage) {
        return {
            shouldClose: false,
            statusText: validationMessage,
        };
    }

    try {
        await send(body, title);
        return {
            shouldClose: true,
            statusText: '',
            noticeText: 'Notification accepted by ntfy.',
        };
    } catch (error) {
        return {
            shouldClose: false,
            statusText: getManualComposerFailureMessage(error),
        };
    }
}
