export type ManualComposerSubmitResult = {
    shouldClose: boolean;
    statusText: string;
    noticeText?: string;
};

export function getManualComposerFailureMessage(error: unknown): string {
    const message = error instanceof Error ? error.message : 'Failed to send notification.';

    if (message === 'TPS Notifier delivery is disabled in settings.') {
        return 'TPS Notifier delivery is disabled in settings. Enable delivery transport in TPS Notifier settings, then try again.';
    }

    return `${message} Fix the settings or network issue, then try again.`;
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
            noticeText: 'Notification Sent',
        };
    } catch (error) {
        return {
            shouldClose: false,
            statusText: getManualComposerFailureMessage(error),
        };
    }
}
