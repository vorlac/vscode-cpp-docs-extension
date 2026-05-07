// Trailing-edge debounce wrapper.
//
// Used by the cursor-follow subscription in `extension.ts` to coalesce
// `vscode.window.onDidChangeTextEditorSelection` events: a burst of
// selection events from a fast cursor move turns into a single resolver
// invocation after the wave settles, with the LAST event's arguments
// (the position the user actually came to rest on).
//
// Trailing-only — there is no leading-edge variant. The cursor-follow
// semantics in docs/03-symbol-resolution.md call for "wait for the user
// to stop moving, then resolve"; firing on the leading edge would
// resolve at the moving-from position, which is usually not what the
// user wants to read about.
//
// Delay is either a fixed number or a function evaluated on every call,
// so a config change to `cppDocs.panel.followCursorDebounceMs` takes
// effect on the next event without re-creating the subscription.
//
// The returned wrapper exposes `cancel()`, which clears any pending
// trailing call and is safe to push into a vscode `Disposable` slot
// (`{ dispose: () => debounced.cancel() }`).

/**
 * Debounce result. Calling the wrapper schedules a trailing-edge
 * invocation; calling `cancel()` clears any pending invocation. The
 * `flush()` helper invokes the pending call immediately (useful for
 * tests; not used by production code today).
 */
export interface Debounced<Args extends readonly unknown[]> {
    (...args: Args): void;
    cancel(): void;
    flush(): void;
}

/**
 * Build a trailing-edge debounce wrapper around `fn`.
 *
 *   const debounced = debounce(() => doWork(), 150);
 *   debounced();   // schedules doWork in 150 ms
 *   debounced();   // resets the 150 ms timer
 *   // ... 150 ms idle ...
 *   //   → doWork() fires once with the second-call's args
 *
 * `delay` may be a function — re-evaluated on every call so users can
 * change the debounce interval at runtime via configuration without
 * tearing down the subscription.
 *
 * The wrapper has no return value; trailing-edge debounce can't return
 * anything sensible (the call hasn't happened yet). The wrapped `fn`
 * may return a promise — its resolution is ignored.
 *
 * `cancel()` is the disposable hook. `flush()` invokes the pending call
 * immediately (using the most recent args). Both are no-ops when no
 * call is pending.
 */
export function debounce<Args extends readonly unknown[]>(
    fn: (...args: Args) => void | Promise<void>,
    delay: number | (() => number)
): Debounced<Args> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pendingArgs: Args | undefined;

    const fire = (): void => {
        timer = undefined;
        const args = pendingArgs;
        pendingArgs = undefined;
        if (args === undefined) return;
        void fn(...args);
    };

    const wrapped = ((...args: Args): void => {
        pendingArgs = args;
        if (timer !== undefined) clearTimeout(timer);
        const ms = typeof delay === 'function' ? delay() : delay;
        timer = setTimeout(fire, Math.max(0, ms));
    }) as Debounced<Args>;

    wrapped.cancel = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        pendingArgs = undefined;
    };

    wrapped.flush = (): void => {
        if (timer === undefined) return;
        clearTimeout(timer);
        fire();
    };

    return wrapped;
}
