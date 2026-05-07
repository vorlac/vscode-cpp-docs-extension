// Unit tests for the M4.5 resolver cache.
//
// Two layers:
//   1. The cache itself (`createResolverCache`) — pure data structure
//      tests, no vscode dependency. Covers basic put/get, key
//      separation by uri/version, LRU eviction, recency bump on read,
//      negative caching (`null` sentinel), and `clear()`.
//   2. The wrapper (`wrapWithCache`) — exercises the resolver-shaped
//      facade against a counted mock inner resolver, asserting that
//      hits short-circuit, that cached misses also short-circuit, and
//      that a version bump invalidates a previous entry.
//
// Per docs/03-symbol-resolution.md § "Caching":
//   - key  = `${uri}|${version}|${line}:${character}`
//   - cap  = 256 (we override to small numbers in eviction tests)
//   - TTL  = none (version handles invalidation)
//   - cache stores hits AND misses (so a cursor parked on whitespace
//     doesn't keep paying the full chain cost)

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    createResolverCache,
    wrapWithCache
} from '../../src/resolver/cache.js';
import type { ResolvedSymbol, Resolver } from '../../src/resolver/types.js';

// ---- minimal vscode stubs -------------------------------------------

// The cache itself takes raw primitives, but `wrapWithCache`'s resolver
// signature wants `vscode.TextDocument` / `vscode.Position`. Same
// approach as M4.0's contract test: structural duck-types cast through
// `unknown` to the real vscode types.
function makeDoc(uri: string, version: number): vscode.TextDocument {
    return {
        uri: { toString: (): string => uri },
        version
    } as unknown as vscode.TextDocument;
}

function makePos(line: number, character: number): vscode.Position {
    return { line, character } as unknown as vscode.Position;
}

const SAMPLE_SYMBOL: ResolvedSymbol = {
    fqn: 'std::vector::push_back',
    source: 'clangd'
};

// ---- cache-only tests -----------------------------------------------

describe('createResolverCache', () => {
    it('returns undefined for an empty cache', () => {
        const cache = createResolverCache();
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toBeUndefined();
        expect(cache.size()).toBe(0);
    });

    it('stores and retrieves a value by exact key', () => {
        const cache = createResolverCache();
        cache.set('file:///a.cpp', 1, 0, 0, SAMPLE_SYMBOL);
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toEqual(SAMPLE_SYMBOL);
        expect(cache.size()).toBe(1);
    });

    it('keeps entries for different URIs separate', () => {
        const cache = createResolverCache();
        const a: ResolvedSymbol = { fqn: 'A' };
        const b: ResolvedSymbol = { fqn: 'B' };
        cache.set('file:///a.cpp', 1, 0, 0, a);
        cache.set('file:///b.cpp', 1, 0, 0, b);
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toEqual(a);
        expect(cache.get('file:///b.cpp', 1, 0, 0)).toEqual(b);
        expect(cache.size()).toBe(2);
    });

    it('keeps entries for different document versions separate', () => {
        const cache = createResolverCache();
        const v1: ResolvedSymbol = { fqn: 'old' };
        const v2: ResolvedSymbol = { fqn: 'new' };
        cache.set('file:///a.cpp', 1, 0, 0, v1);
        cache.set('file:///a.cpp', 2, 0, 0, v2);
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toEqual(v1);
        expect(cache.get('file:///a.cpp', 2, 0, 0)).toEqual(v2);
        // The v=1 entry isn't auto-evicted; selective invalidation is M4.6.
        expect(cache.size()).toBe(2);
    });

    it('evicts the oldest entry when capacity is exceeded', () => {
        const cache = createResolverCache({ capacity: 3 });
        cache.set('file:///x.cpp', 1, 0, 0, { fqn: 'A' });
        cache.set('file:///x.cpp', 1, 1, 0, { fqn: 'B' });
        cache.set('file:///x.cpp', 1, 2, 0, { fqn: 'C' });
        cache.set('file:///x.cpp', 1, 3, 0, { fqn: 'D' });
        expect(cache.capacity()).toBe(3);
        expect(cache.size()).toBe(3);
        expect(cache.get('file:///x.cpp', 1, 0, 0)).toBeUndefined();
        expect(cache.get('file:///x.cpp', 1, 1, 0)).toEqual({ fqn: 'B' });
        expect(cache.get('file:///x.cpp', 1, 2, 0)).toEqual({ fqn: 'C' });
        expect(cache.get('file:///x.cpp', 1, 3, 0)).toEqual({ fqn: 'D' });
    });

    it('bumps recency on get so the LRU victim is the truly-least-recent', () => {
        const cache = createResolverCache({ capacity: 3 });
        cache.set('file:///x.cpp', 1, 0, 0, { fqn: 'A' });
        cache.set('file:///x.cpp', 1, 1, 0, { fqn: 'B' });
        cache.set('file:///x.cpp', 1, 2, 0, { fqn: 'C' });
        // Touch A — now order is [B, C, A] from oldest to newest.
        expect(cache.get('file:///x.cpp', 1, 0, 0)).toEqual({ fqn: 'A' });
        // Insert D — evicts B.
        cache.set('file:///x.cpp', 1, 3, 0, { fqn: 'D' });
        expect(cache.get('file:///x.cpp', 1, 1, 0)).toBeUndefined();
        expect(cache.get('file:///x.cpp', 1, 0, 0)).toEqual({ fqn: 'A' });
        expect(cache.get('file:///x.cpp', 1, 2, 0)).toEqual({ fqn: 'C' });
        expect(cache.get('file:///x.cpp', 1, 3, 0)).toEqual({ fqn: 'D' });
    });

    it('caches misses via the null sentinel and distinguishes them from absence', () => {
        const cache = createResolverCache();
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toBeUndefined();
        cache.set('file:///a.cpp', 1, 0, 0, null);
        // Cached miss: `null`, NOT `undefined`. Wrapper distinguishes:
        // `null` = "cached miss, don't recompute"; `undefined` = "not in
        // cache".
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toBeNull();
        expect(cache.size()).toBe(1);
    });

    it('clear() wipes everything', () => {
        const cache = createResolverCache();
        cache.set('file:///a.cpp', 1, 0, 0, SAMPLE_SYMBOL);
        cache.set('file:///b.cpp', 1, 0, 0, null);
        expect(cache.size()).toBe(2);
        cache.clear();
        expect(cache.size()).toBe(0);
        expect(cache.get('file:///a.cpp', 1, 0, 0)).toBeUndefined();
        expect(cache.get('file:///b.cpp', 1, 0, 0)).toBeUndefined();
    });

    it('rejects non-positive or non-integer capacity', () => {
        expect(() => createResolverCache({ capacity: 0 })).toThrow();
        expect(() => createResolverCache({ capacity: -1 })).toThrow();
        expect(() => createResolverCache({ capacity: 1.5 })).toThrow();
    });

    it('overwriting an existing key updates the value and bumps recency', () => {
        const cache = createResolverCache({ capacity: 2 });
        cache.set('file:///x.cpp', 1, 0, 0, { fqn: 'A1' });
        cache.set('file:///x.cpp', 1, 1, 0, { fqn: 'B' });
        // Overwrite A — now order is [B, A2], so the next insert evicts B.
        cache.set('file:///x.cpp', 1, 0, 0, { fqn: 'A2' });
        cache.set('file:///x.cpp', 1, 2, 0, { fqn: 'C' });
        expect(cache.get('file:///x.cpp', 1, 0, 0)).toEqual({ fqn: 'A2' });
        expect(cache.get('file:///x.cpp', 1, 1, 0)).toBeUndefined();
        expect(cache.get('file:///x.cpp', 1, 2, 0)).toEqual({ fqn: 'C' });
    });
});

// ---- wrapWithCache --------------------------------------------------

describe('wrapWithCache', () => {
    function makeInnerResolver(
        impl: (
            doc: vscode.TextDocument,
            pos: vscode.Position
        ) => Promise<ResolvedSymbol | undefined>
    ): { resolver: Resolver; calls: ReturnType<typeof vi.fn> } {
        const calls = vi.fn(impl);
        const resolver: Resolver = {
            strategyOrder: ['clangd', 'hover', 'definition', 'fallback'] as const,
            resolve: calls
        };
        return { resolver, calls };
    }

    it('preserves the inner resolver strategyOrder', () => {
        const cache = createResolverCache();
        const { resolver } = makeInnerResolver(async () => undefined);
        const wrapped = wrapWithCache(resolver, cache);
        expect(wrapped.strategyOrder).toEqual([
            'clangd',
            'hover',
            'definition',
            'fallback'
        ]);
    });

    it('first call delegates to the inner resolver and populates the cache', async () => {
        const cache = createResolverCache();
        const { resolver, calls } = makeInnerResolver(async () => SAMPLE_SYMBOL);
        const wrapped = wrapWithCache(resolver, cache);
        const doc = makeDoc('file:///a.cpp', 1);
        const pos = makePos(0, 5);

        const result = await wrapped.resolve(doc, pos);
        expect(result).toEqual(SAMPLE_SYMBOL);
        expect(calls).toHaveBeenCalledTimes(1);
        expect(cache.size()).toBe(1);
        expect(cache.get('file:///a.cpp', 1, 0, 5)).toEqual(SAMPLE_SYMBOL);
    });

    it('repeats the same key without invoking the inner resolver', async () => {
        const cache = createResolverCache();
        const { resolver, calls } = makeInnerResolver(async () => SAMPLE_SYMBOL);
        const wrapped = wrapWithCache(resolver, cache);
        const doc = makeDoc('file:///a.cpp', 1);
        const pos = makePos(0, 5);

        expect(await wrapped.resolve(doc, pos)).toEqual(SAMPLE_SYMBOL);
        expect(await wrapped.resolve(doc, pos)).toEqual(SAMPLE_SYMBOL);
        expect(await wrapped.resolve(doc, pos)).toEqual(SAMPLE_SYMBOL);
        expect(calls).toHaveBeenCalledTimes(1);
    });

    it('invokes the inner resolver again after document version changes', async () => {
        const cache = createResolverCache();
        const v1: ResolvedSymbol = { fqn: 'old::sym' };
        const v2: ResolvedSymbol = { fqn: 'new::sym' };
        const { resolver, calls } = makeInnerResolver(async (doc) =>
            doc.version === 1 ? v1 : v2
        );
        const wrapped = wrapWithCache(resolver, cache);
        const pos = makePos(0, 5);

        expect(await wrapped.resolve(makeDoc('file:///a.cpp', 1), pos)).toEqual(v1);
        expect(await wrapped.resolve(makeDoc('file:///a.cpp', 1), pos)).toEqual(v1);
        expect(calls).toHaveBeenCalledTimes(1);
        // Version bump → key changes → fresh delegation.
        expect(await wrapped.resolve(makeDoc('file:///a.cpp', 2), pos)).toEqual(v2);
        expect(calls).toHaveBeenCalledTimes(2);
    });

    it('caches misses: inner returns undefined once, repeats short-circuit', async () => {
        const cache = createResolverCache();
        const { resolver, calls } = makeInnerResolver(async () => undefined);
        const wrapped = wrapWithCache(resolver, cache);
        const doc = makeDoc('file:///a.cpp', 1);
        const pos = makePos(0, 5);

        expect(await wrapped.resolve(doc, pos)).toBeUndefined();
        expect(await wrapped.resolve(doc, pos)).toBeUndefined();
        expect(await wrapped.resolve(doc, pos)).toBeUndefined();
        expect(calls).toHaveBeenCalledTimes(1);
        // The cached miss is stored as `null` in the underlying cache.
        expect(cache.get('file:///a.cpp', 1, 0, 5)).toBeNull();
    });

    it('treats different cursor positions as separate cache entries', async () => {
        const cache = createResolverCache();
        const { resolver, calls } = makeInnerResolver(async (_doc, pos) => ({
            fqn: `sym@${pos.line}:${pos.character}`
        }));
        const wrapped = wrapWithCache(resolver, cache);
        const doc = makeDoc('file:///a.cpp', 1);

        expect(await wrapped.resolve(doc, makePos(0, 0))).toEqual({
            fqn: 'sym@0:0'
        });
        expect(await wrapped.resolve(doc, makePos(0, 1))).toEqual({
            fqn: 'sym@0:1'
        });
        expect(await wrapped.resolve(doc, makePos(1, 0))).toEqual({
            fqn: 'sym@1:0'
        });
        expect(calls).toHaveBeenCalledTimes(3);
        // A repeat at the first position is a hit.
        expect(await wrapped.resolve(doc, makePos(0, 0))).toEqual({
            fqn: 'sym@0:0'
        });
        expect(calls).toHaveBeenCalledTimes(3);
    });
});
