// Unit tests for the trailing-edge debounce helper.
//
// Used by the cursor-follow subscription in `extension.ts`. The
// behavior we lock here:
//   - Trailing-only — the wrapped callback fires AFTER the quiet
//     window expires, never on the leading edge.
//   - The latest call's args are what get delivered (so a fast cursor
//     scrub doesn't resolve at the source position).
//   - `delay` may be a function — re-evaluated on every call so a
//     config change to `cppDocs.panel.followCursorDebounceMs` takes
//     effect on the next event.
//   - `cancel()` clears any pending invocation; safe to call from
//     vscode's `Disposable.dispose`.
//   - `flush()` invokes the pending call immediately (test helper).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { debounce } from '../../src/util/debounce.js';

describe('debounce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('fires once after the delay following a single call', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('a');
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('a');
    });

    it('coalesces multiple calls within the delay into one trailing call with the latest args', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('a');
        vi.advanceTimersByTime(50);
        d('b');
        vi.advanceTimersByTime(50);
        d('c');
        // The last `d('c')` reset the timer; only after another 100ms
        // idle does it fire.
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(99);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('c');
    });

    it('resets the timer on every new call', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        for (let i = 0; i < 10; i++) {
            d(i);
            vi.advanceTimersByTime(50); // never enough to fire
        }
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(9);
    });

    it('accepts a function for delay; re-evaluates it on each call', () => {
        const fn = vi.fn();
        let currentDelay = 100;
        const d = debounce(fn, () => currentDelay);

        d('a');
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenLastCalledWith('a');

        // Mid-life delay change.
        currentDelay = 300;
        d('b');
        vi.advanceTimersByTime(100); // would have fired with old delay
        expect(fn).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(200); // total 300 — new delay
        expect(fn).toHaveBeenCalledTimes(2);
        expect(fn).toHaveBeenLastCalledWith('b');
    });

    it('cancel() clears a pending invocation (suitable for vscode Disposable)', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('a');
        d.cancel();
        vi.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();

        // Cancel is idempotent / safe to call when nothing is pending —
        // this is what the `{ dispose: () => d.cancel() }` slot expects.
        expect(() => d.cancel()).not.toThrow();
        expect(() => d.cancel()).not.toThrow();
    });

    it('flush() invokes the pending call immediately with the latest args', () => {
        const fn = vi.fn();
        const d = debounce(fn, 1000);
        d('first');
        d('second');
        d.flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('second');

        // After flush, no further invocation should happen at the
        // original delay.
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('flush() is a no-op when nothing is pending', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        expect(() => d.flush()).not.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });

    it('cancel() then call() schedules a fresh invocation', () => {
        const fn = vi.fn();
        const d = debounce(fn, 100);
        d('a');
        d.cancel();
        d('b');
        vi.advanceTimersByTime(100);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith('b');
    });

    it('preserves multiple-arg signatures', () => {
        const fn = vi.fn();
        const d = debounce(fn, 50);
        d(1, 2, 3);
        vi.advanceTimersByTime(50);
        expect(fn).toHaveBeenCalledWith(1, 2, 3);
    });

    it('treats negative delays as 0 (fire on next tick)', () => {
        const fn = vi.fn();
        const d = debounce(fn, -50);
        d('x');
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(0);
        expect(fn).toHaveBeenCalledTimes(1);
    });
});
