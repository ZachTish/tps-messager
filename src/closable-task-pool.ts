export class TaskPoolCapacityError extends Error {
    constructor() {
        super('Task pool capacity reached.');
        this.name = 'TaskPoolCapacityError';
        Object.setPrototypeOf(this, new.target.prototype);
    }
}

type PendingTask<T> = {
    task: () => Promise<T>;
    resolve: (value: T | PromiseLike<T>) => void;
    reject: (reason?: unknown) => void;
};

export class ClosableTaskPool {
    private active = 0;
    private readonly pending: PendingTask<unknown>[] = [];
    private closed = false;
    private closedReason: unknown;

    constructor(
        private readonly concurrency: number,
        private readonly maxPending: number,
    ) {
        if (!Number.isInteger(concurrency) || concurrency < 1) {
            throw new RangeError('Task pool concurrency must be a positive integer.');
        }
        if (!Number.isInteger(maxPending) || maxPending < 0) {
            throw new RangeError('Task pool pending limit must be a non-negative integer.');
        }
    }

    get activeCount(): number {
        return this.active;
    }

    get pendingCount(): number {
        return this.pending.length;
    }

    run<T>(task: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(this.closedReason);
        if (this.active >= this.concurrency && this.pending.length >= this.maxPending) {
            return Promise.reject(new TaskPoolCapacityError());
        }
        return new Promise<T>((resolve, reject) => {
            this.pending.push({
                task,
                resolve,
                reject,
            } as PendingTask<unknown>);
            this.drain();
        });
    }

    close(reason: unknown = new Error('Task pool is closed.')): void {
        if (this.closed) return;
        this.closed = true;
        this.closedReason = reason;
        this.cancelPending(reason);
    }

    cancelPending(reason: unknown): void {
        for (const item of this.pending.splice(0)) item.reject(reason);
    }

    private drain(): void {
        while (!this.closed
            && this.active < this.concurrency
            && this.pending.length > 0) {
            const item = this.pending.shift() as PendingTask<unknown>;
            this.active += 1;
            let result: Promise<unknown>;
            try {
                result = item.task();
            } catch (error) {
                result = Promise.reject(error);
            }
            void result.then(item.resolve, item.reject).finally(() => {
                this.active = Math.max(0, this.active - 1);
                this.drain();
            });
        }
    }
}
