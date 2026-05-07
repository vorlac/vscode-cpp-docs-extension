// Unit tests for the include-context-aware resolver wrapper.
//
// Covers the three-way behavior matrix:
//   - non-include line   → delegate to the inner resolver verbatim
//   - quoted include     → unconditionally undefined (never delegate)
//   - system include     → exact Header-kind index match, else undefined
//
// The "never delegate" property is the load-bearing one for the bug
// this module fixes: with `#include "core/concepts.hpp"`, the inner
// fallback strategy would happily match the bare word `concepts`
// against `cpp/header/concepts.html`. The wrapper has to short-circuit
// before any strategy sees the position.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    detectIncludeContext,
    wrapWithIncludeAwareness,
    type IncludeAwareIndex
} from '../../src/resolver/include-aware.js';
import type { ResolvedSymbol, Resolver } from '../../src/resolver/types.js';

function makeDoc(lines: string[]): vscode.TextDocument {
    return {
        lineAt: (line: number) => ({ text: lines[line] ?? '' })
    } as unknown as vscode.TextDocument;
}

function makePos(line: number, character: number): vscode.Position {
    return { line, character } as unknown as vscode.Position;
}

function makeInner(value: ResolvedSymbol | undefined): {
    inner: Resolver;
    calls: { count: number };
} {
    const calls = { count: 0 };
    const inner: Resolver = {
        strategyOrder: ['fallback'],
        async resolve(): Promise<ResolvedSymbol | undefined> {
            calls.count++;
            return value;
        }
    };
    return { inner, calls };
}

function makeIndex(
    rows: Record<string, { kind: string }>
): IncludeAwareIndex {
    return {
        lookupHeader: (name) =>
            rows[name]?.kind === 'Header' ? rows[name] : undefined
    };
}

describe('detectIncludeContext', () => {
    it('returns undefined for ordinary code lines', () => {
        const doc = makeDoc(['int main() { return 0; }']);
        expect(detectIncludeContext(doc, makePos(0, 4))).toBeUndefined();
    });

    it('recognizes a system include', () => {
        const doc = makeDoc(['#include <vector>']);
        expect(detectIncludeContext(doc, makePos(0, 11))).toEqual({
            kind: 'system',
            name: 'vector'
        });
    });

    it('recognizes a quoted include', () => {
        const doc = makeDoc(['#include "core/concepts.hpp"']);
        expect(detectIncludeContext(doc, makePos(0, 14))).toEqual({
            kind: 'quoted',
            name: 'core/concepts.hpp'
        });
    });

    it('tolerates whitespace around the # and inside the directive', () => {
        const doc = makeDoc(['   #   include   <map>']);
        expect(detectIncludeContext(doc, makePos(0, 18))).toEqual({
            kind: 'system',
            name: 'map'
        });
    });

    it('returns the directive regardless of cursor column on the line', () => {
        const doc = makeDoc(['#include "foo.hpp" // trailing comment']);
        // Cursor on the comment — still an include line.
        expect(detectIncludeContext(doc, makePos(0, 30))).toEqual({
            kind: 'quoted',
            name: 'foo.hpp'
        });
    });

    it('returns undefined if lineAt throws', () => {
        const doc = {
            lineAt: () => {
                throw new Error('out of range');
            }
        } as unknown as vscode.TextDocument;
        expect(detectIncludeContext(doc, makePos(99, 0))).toBeUndefined();
    });
});

describe('wrapWithIncludeAwareness', () => {
    it('delegates to the inner resolver on non-include lines', async () => {
        const doc = makeDoc(['int x = some_symbol;']);
        const { inner, calls } = makeInner({ fqn: 'some_symbol' });
        const wrapped = wrapWithIncludeAwareness(inner, makeIndex({}));
        const result = await wrapped.resolve(doc, makePos(0, 10));
        expect(result?.fqn).toBe('some_symbol');
        expect(calls.count).toBe(1);
    });

    it('returns undefined for quoted includes without consulting the inner', async () => {
        // The inner resolver is rigged to return a (wrong) symbol so the
        // test would fail if the wrapper delegated anyway.
        const doc = makeDoc(['#include "core/concepts.hpp"']);
        const { inner, calls } = makeInner({ fqn: 'concepts' });
        const wrapped = wrapWithIncludeAwareness(
            inner,
            makeIndex({ concepts: { kind: 'Header' } })
        );
        const result = await wrapped.resolve(doc, makePos(0, 14));
        expect(result).toBeUndefined();
        expect(calls.count).toBe(0);
    });

    it('resolves a system include to its Header-kind index entry', async () => {
        const doc = makeDoc(['#include <vector>']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithIncludeAwareness(
            inner,
            makeIndex({ vector: { kind: 'Header' } })
        );
        const result = await wrapped.resolve(doc, makePos(0, 11));
        expect(result?.fqn).toBe('vector');
        // Inner must not be consulted for include lines — the wrapper has
        // already produced the authoritative answer.
        expect(calls.count).toBe(0);
    });

    it('bails on system includes whose bracket name has no Header entry', async () => {
        const doc = makeDoc(['#include <bits/stl_vector.h>']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithIncludeAwareness(inner, makeIndex({}));
        const result = await wrapped.resolve(doc, makePos(0, 14));
        expect(result).toBeUndefined();
        expect(calls.count).toBe(0);
    });

    it('bails on system includes whose name matches a non-Header entry', async () => {
        // A row exists for the bracket content but it's, say, a typedef
        // page or a class — not a stdlib header. We don't want to surface
        // it on an `#include` line.
        const doc = makeDoc(['#include <Foo>']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithIncludeAwareness(
            inner,
            makeIndex({ Foo: { kind: 'Class' } })
        );
        const result = await wrapped.resolve(doc, makePos(0, 11));
        expect(result).toBeUndefined();
        expect(calls.count).toBe(0);
    });

    it('resolves #include <array> even when a Language row shares the name', async () => {
        // Regression: `array` has both a Language row (C++ array-type docs)
        // and a Header row (<array>). The wrapper must resolve to the Header
        // entry, not bail because of the competing Language row.
        const doc = makeDoc(['#include <array>']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithIncludeAwareness(
            inner,
            makeIndex({ array: { kind: 'Header' } })
        );
        const result = await wrapped.resolve(doc, makePos(0, 11));
        expect(result?.fqn).toBe('array');
        expect(calls.count).toBe(0);
    });

    it('bails on #include <array> when only a Language row exists (no Header)', async () => {
        const doc = makeDoc(['#include <array>']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithIncludeAwareness(
            inner,
            makeIndex({ array: { kind: 'Language' } })
        );
        const result = await wrapped.resolve(doc, makePos(0, 11));
        expect(result).toBeUndefined();
        expect(calls.count).toBe(0);
    });

    it('preserves the inner resolver strategyOrder', () => {
        const inner: Resolver = {
            strategyOrder: ['clangd', 'hover', 'definition', 'fallback'],
            resolve: vi.fn()
        };
        const wrapped = wrapWithIncludeAwareness(inner, makeIndex({}));
        expect(wrapped.strategyOrder).toEqual([
            'clangd',
            'hover',
            'definition',
            'fallback'
        ]);
    });
});
