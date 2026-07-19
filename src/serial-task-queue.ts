type PendingTask<T> = {
    task: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

type IdleWaiter = {
    resolve: () => void;
    reject: (reason?: unknown) => void;
    timeoutId?: ReturnType<typeof setTimeout>;
};

type IdleWaitOptions = {
    timeoutMs?: number;
    timeoutReason?: unknown;
};

export class RecoverableSerialTaskQueue {
    private active = false;
    private readonly pending: PendingTask<unknown>[] = [];
    private readonly idleWaiters: IdleWaiter[] = [];
    private closed = false;
    private closedReason: unknown;

    close(reason: unknown = new Error('Task queue is closed.')): void {
        if (this.closed) return;
        this.closed = true;
        this.closedReason = reason;
        for (const item of this.pending.splice(0)) item.reject(reason);
        this.resolveIdleIfNeeded();
    }

    whenIdle(options: IdleWaitOptions = {}): Promise<void> {
        if (!this.active && this.pending.length === 0) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const waiter: IdleWaiter = { resolve, reject };
            if (options.timeoutMs !== undefined) {
                waiter.timeoutId = setTimeout(() => {
                    const index = this.idleWaiters.indexOf(waiter);
                    if (index < 0) return;
                    this.idleWaiters.splice(index, 1);
                    reject(options.timeoutReason ?? new Error('Timed out waiting for the task queue to become idle.'));
                }, options.timeoutMs);
            }
            this.idleWaiters.push(waiter);
        });
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(this.closedReason);
        return new Promise<T>((resolve, reject) => {
            this.pending.push({ task, resolve, reject } as PendingTask<unknown>);
            this.drain();
        });
    }

    private drain(): void {
        if (this.active || this.closed) {
            this.resolveIdleIfNeeded();
            return;
        }
        const item = this.pending.shift();
        if (!item) {
            this.resolveIdleIfNeeded();
            return;
        }

        this.active = true;
        let result: Promise<unknown>;
        try {
            result = item.task();
        } catch (error) {
            result = Promise.reject(error);
        }
        void result.then(item.resolve, item.reject).finally(() => {
            this.active = false;
            this.drain();
        });
    }

    private resolveIdleIfNeeded(): void {
        if (this.active || this.pending.length > 0) return;
        for (const waiter of this.idleWaiters.splice(0)) {
            if (waiter.timeoutId !== undefined) clearTimeout(waiter.timeoutId);
            waiter.resolve();
        }
    }
}
