// End-to-end tests for the M4.6 resolver composer.
//
// We synthesize strategies (no real clangd / hover / definition /
// fallback) so each test pins one composer behavior:
//   - first hit wins
//   - misses advance the chain
//   - timeouts advance the chain (and abort the laggard's signal)
//   - errors advance the chain (including AbortError)
//   - all-miss returns undefined
//   - strategyOrder mirrors the input order
//   - source-tag is populated only when the strategy didn't set it
//
// Vitest's fake timers drive the timeout race deterministically.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { composeResolver } from '../../src/resolver/cpp.js';
import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy,
    ResolverStrategyName
} from '../../src/resolver/types.js';
import type * as vscode from 'vscode';

function makeDoc(uri = 'file:///t.cpp', version = 1): vscode.TextDocument {
    return {
        uri: { toString: (): string => uri },
        version,
        languageId: 'cpp',
        getText: (): string => ''
    } as unknown as vscode.TextDocument;
}

function makePos(line = 0, character = 0): vscode.Position {
    return { line, character } as unknown as vscode.Position;
}

/**
 * Strategy stub builder. Optional `delayMs` makes the strategy resolve
 * on a timer (so we can simulate a strategy slower than the composer's
 * timeout). When `delayMs` is undefined the strategy resolves
 * synchronously.
 */
function makeSlowStrategy(opts: {
    delayMs?: number;
    result?: ResolvedSymbol | undefined;
    throws?: unknown;
    capture?: { signal?: AbortSignal };
}): ResolverStrategy {
    return async (ctx: ResolveContext) => {
        if (opts.capture) opts.capture.signal = ctx.signal;
        if (opts.delayMs !== undefined) {
            await new Promise((r) => setTimeout(r, opts.delayMs));
        }
        if (opts.throws) throw opts.throws;
        return opts.result;
    };
}

describe('composeResolver', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('exposes strategyOrder matching the input order', () => {
        const noopStrategy: ResolverStrategy = async () => undefined;
        const order: ResolverStrategyName[] = [
            'clangd',
            'hover',
            'definition',
            'fallback'
        ];
        const r = composeResolver(
            order.map((name) => ({ name, strategy: noopStrategy }))
        );
        expect(r.strategyOrder).toEqual(order);
    });

    it('stops at the first strategy that returns a hit', async () => {
        const second = vi.fn(makeSlowStrategy({ result: { fqn: 'second-hit' } }));
        const third = vi.fn(makeSlowStrategy({ result: { fqn: 'third-hit' } }));
        const first = vi.fn(makeSlowStrategy({ result: { fqn: 'std::vector' } }));
        const r = composeResolver([
            { name: 'clangd', strategy: first },
            { name: 'hover', strategy: second },
            { name: 'definition', strategy: third }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.fqn).toBe('std::vector');
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).not.toHaveBeenCalled();
        expect(third).not.toHaveBeenCalled();
    });

    it('falls through misses to the next strategy', async () => {
        const a = vi.fn(makeSlowStrategy({ result: undefined }));
        const b = vi.fn(makeSlowStrategy({ result: undefined }));
        const c = vi.fn(makeSlowStrategy({ result: { fqn: 'std::sort' } }));
        const r = composeResolver([
            { name: 'clangd', strategy: a },
            { name: 'hover', strategy: b },
            { name: 'definition', strategy: c }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.fqn).toBe('std::sort');
        expect(result?.source).toBe('definition');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
        expect(c).toHaveBeenCalledTimes(1);
    });

    it('treats a thrown error as a miss (chain advances)', async () => {
        const a = vi.fn(makeSlowStrategy({ throws: new Error('boom') }));
        const b = vi.fn(makeSlowStrategy({ result: { fqn: 'recovered' } }));
        const r = composeResolver([
            { name: 'clangd', strategy: a },
            { name: 'hover', strategy: b }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.fqn).toBe('recovered');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('treats AbortError as a miss (chain advances)', async () => {
        const abortErr = (() => {
            if (typeof DOMException === 'function')
                return new DOMException('Aborted', 'AbortError');
            const e = new Error('Aborted');
            e.name = 'AbortError';
            return e;
        })();
        const a = vi.fn(makeSlowStrategy({ throws: abortErr }));
        const b = vi.fn(makeSlowStrategy({ result: { fqn: 'after-abort' } }));
        const r = composeResolver([
            { name: 'clangd', strategy: a },
            { name: 'hover', strategy: b }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.fqn).toBe('after-abort');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('times out a slow strategy and advances; the late settlement is ignored', async () => {
        let lateResolved = false;
        // `a` resolves 500ms after the 100ms timeout.
        const a: ResolverStrategy = async () => {
            await new Promise((r) => setTimeout(r, 500));
            lateResolved = true;
            return { fqn: 'late-hit' };
        };
        const b = vi.fn(makeSlowStrategy({ result: { fqn: 'fast-hit' } }));
        const r = composeResolver(
            [
                { name: 'clangd', strategy: a },
                { name: 'hover', strategy: b }
            ],
            { timeoutMs: 100 }
        );

        const promise = r.resolve(makeDoc(), makePos());
        // Run pending microtasks + advance timers to fire the timeout.
        await vi.advanceTimersByTimeAsync(100);
        // After the timeout, the composer moves on to `b`; let microtasks
        // drain so it returns.
        await vi.advanceTimersByTimeAsync(0);
        const result = await promise;
        expect(result?.fqn).toBe('fast-hit');
        expect(b).toHaveBeenCalledTimes(1);

        // The slow strategy still settles, but the composer doesn't care.
        await vi.advanceTimersByTimeAsync(500);
        expect(lateResolved).toBe(true);
    });

    it('aborts the timed-out strategy via its ctx.signal', async () => {
        const captured: { signal?: AbortSignal } = {};
        const slow = makeSlowStrategy({ delayMs: 500, capture: captured });
        const fast = makeSlowStrategy({ result: { fqn: 'fast' } });
        const r = composeResolver(
            [
                { name: 'clangd', strategy: slow },
                { name: 'hover', strategy: fast }
            ],
            { timeoutMs: 50 }
        );

        const promise = r.resolve(makeDoc(), makePos());
        // The composer queues the strategy invocation as a microtask via
        // `Promise.resolve().then(...)`; flush microtasks (advance 0ms)
        // so the strategy actually starts and captures the signal.
        await vi.advanceTimersByTimeAsync(0);
        expect(captured.signal).toBeDefined();
        expect(captured.signal!.aborted).toBe(false);
        await vi.advanceTimersByTimeAsync(50);
        expect(captured.signal!.aborted).toBe(true);
        await vi.advanceTimersByTimeAsync(0);
        await promise;
    });

    it('returns undefined when every strategy misses', async () => {
        const r = composeResolver([
            { name: 'clangd', strategy: makeSlowStrategy({ result: undefined }) },
            { name: 'hover', strategy: makeSlowStrategy({ result: undefined }) },
            { name: 'definition', strategy: makeSlowStrategy({ result: undefined }) },
            { name: 'fallback', strategy: makeSlowStrategy({ result: undefined }) }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result).toBeUndefined();
    });

    it('preserves a source field set by the strategy itself (does not overwrite)', async () => {
        const r = composeResolver([
            {
                name: 'clangd',
                strategy: makeSlowStrategy({
                    // Strategy claims a different source than its registered name.
                    // The composer must not overwrite.
                    result: { fqn: 'X', source: 'fallback' }
                })
            }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.source).toBe('fallback');
    });

    it('fills source from the registered name when the strategy leaves it unset', async () => {
        const r = composeResolver([
            {
                name: 'hover',
                strategy: makeSlowStrategy({ result: { fqn: 'X' } })
            }
        ]);
        const result = await r.resolve(makeDoc(), makePos());
        expect(result?.source).toBe('hover');
        expect(result?.fqn).toBe('X');
    });

    it('uses the default 250ms timeout when none is specified', async () => {
        let started = 0;
        const slow: ResolverStrategy = async () => {
            started++;
            await new Promise((r) => setTimeout(r, 1000));
            return { fqn: 'late' };
        };
        const fast = makeSlowStrategy({ result: { fqn: 'fast' } });
        const r = composeResolver([
            { name: 'clangd', strategy: slow },
            { name: 'hover', strategy: fast }
        ]);

        const promise = r.resolve(makeDoc(), makePos());
        // Flush microtasks so the first strategy actually starts.
        await vi.advanceTimersByTimeAsync(0);
        expect(started).toBe(1);
        await vi.advanceTimersByTimeAsync(249);
        // not yet timed out
        await vi.advanceTimersByTimeAsync(1);
        await vi.advanceTimersByTimeAsync(0);
        const result = await promise;
        expect(result?.fqn).toBe('fast');
    });

    it('passes a fresh AbortController per strategy (signals are not shared)', async () => {
        const capA: { signal?: AbortSignal } = {};
        const capB: { signal?: AbortSignal } = {};
        const capC: { signal?: AbortSignal } = {};
        const r = composeResolver([
            {
                name: 'clangd',
                strategy: makeSlowStrategy({ result: undefined, capture: capA })
            },
            {
                name: 'hover',
                strategy: makeSlowStrategy({ result: undefined, capture: capB })
            },
            {
                name: 'definition',
                strategy: makeSlowStrategy({ result: undefined, capture: capC })
            }
        ]);
        await r.resolve(makeDoc(), makePos());
        // Each strategy got a distinct signal.
        expect(capA.signal).toBeDefined();
        expect(capB.signal).toBeDefined();
        expect(capC.signal).toBeDefined();
        expect(capA.signal).not.toBe(capB.signal);
        expect(capB.signal).not.toBe(capC.signal);
    });
});
