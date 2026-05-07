export function makeAbortError(): Error {
    if (typeof DOMException === 'function') {
        return new DOMException('Aborted', 'AbortError');
    }
    const err = new Error('Aborted');
    err.name = 'AbortError';
    return err;
}

export function isAbortError(err: unknown): boolean {
    return err instanceof Error && err.name === 'AbortError';
}

export async function raceWithAbort<T>(promise: Thenable<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw makeAbortError();
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const onAbort = (): void => {
            if (!settled) {
                settled = true;
                reject(makeAbortError());
            }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            (v) => {
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve(v);
            },
            (e) => {
                settled = true;
                signal.removeEventListener('abort', onAbort);
                reject(e);
            }
        );
    });
}
