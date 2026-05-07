// Unit tests for the preprocessor-directive-aware resolver wrapper.
//
// Covers the four-way behavior matrix:
//   - non-directive line              → delegate to inner resolver verbatim
//   - cursor on directive keyword     → short-circuit to Directive-kind DB entry
//   - cursor anywhere on #pragma line → short-circuit to 'pragma' Directive entry
//   - cursor on directive operand     → delegate (NDEBUG in #if, FOO in #define)
//   - #include lines                  → delegate; wrapWithIncludeAwareness owns these
//
// The load-bearing correctness property: cursor-on-`if` inside `#if NDEBUG`
// must NOT resolve to the C++ `if` keyword page. The wrapper must intercept
// before the keyword strategy sees the position.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    detectDirectiveContext,
    wrapWithDirectiveAwareness,
    type DirectiveAwareIndex
} from '../../src/resolver/directive-aware.js';
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
        strategyOrder: ['keyword', 'fallback'],
        async resolve(): Promise<ResolvedSymbol | undefined> {
            calls.count++;
            return value;
        }
    };
    return { inner, calls };
}

function makeIndex(rows: Record<string, { kind: string }>): DirectiveAwareIndex {
    return { lookupExact: (name) => rows[name] };
}

const DIRECTIVES: Record<string, { kind: string }> = {
    if: { kind: 'Directive' },
    ifdef: { kind: 'Directive' },
    ifndef: { kind: 'Directive' },
    elif: { kind: 'Directive' },
    else: { kind: 'Directive' },
    endif: { kind: 'Directive' },
    define: { kind: 'Directive' },
    undef: { kind: 'Directive' },
    pragma: { kind: 'Directive' },
    error: { kind: 'Directive' },
    warning: { kind: 'Directive' },
    line: { kind: 'Directive' }
};

// ---------------------------------------------------------------------------
// detectDirectiveContext
// ---------------------------------------------------------------------------

describe('detectDirectiveContext', () => {
    it('returns undefined for ordinary code lines', () => {
        const doc = makeDoc(['if (x > 0) { return 0; }']);
        expect(detectDirectiveContext(doc, makePos(0, 0))).toBeUndefined();
    });

    it('returns undefined for blank lines', () => {
        const doc = makeDoc(['']);
        expect(detectDirectiveContext(doc, makePos(0, 0))).toBeUndefined();
    });

    it('returns undefined if lineAt throws', () => {
        const doc = {
            lineAt: () => {
                throw new Error('out of range');
            }
        } as unknown as vscode.TextDocument;
        expect(detectDirectiveContext(doc, makePos(99, 0))).toBeUndefined();
    });

    it('detects `#if` and reports cursor on directive keyword', () => {
        // `#if NDEBUG` — cursor on 'if' (cols 1-2)
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 1));
        expect(ctx).toEqual({ directive: 'if', onDirectiveName: true });
    });

    it('detects `#if` and reports cursor NOT on directive keyword', () => {
        // cursor on 'NDEBUG' (col 4)
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 4));
        expect(ctx).toEqual({ directive: 'if', onDirectiveName: false });
    });

    it('detects `#pragma once` — cursor on pragma keyword', () => {
        const doc = makeDoc(['#pragma once']);
        // 'pragma' occupies cols 1–6
        const ctx = detectDirectiveContext(doc, makePos(0, 3));
        expect(ctx).toEqual({ directive: 'pragma', onDirectiveName: true });
    });

    it('detects `#pragma once` — cursor on `once`', () => {
        const doc = makeDoc(['#pragma once']);
        // 'once' starts at col 8
        const ctx = detectDirectiveContext(doc, makePos(0, 9));
        expect(ctx).toEqual({ directive: 'pragma', onDirectiveName: false });
    });

    it('detects `#define FOO 1` — cursor on define keyword', () => {
        const doc = makeDoc(['#define FOO 1']);
        const ctx = detectDirectiveContext(doc, makePos(0, 2));
        expect(ctx).toEqual({ directive: 'define', onDirectiveName: true });
    });

    it('detects `#define FOO 1` — cursor on FOO operand', () => {
        const doc = makeDoc(['#define FOO 1']);
        // FOO starts at col 8
        const ctx = detectDirectiveContext(doc, makePos(0, 9));
        expect(ctx).toEqual({ directive: 'define', onDirectiveName: false });
    });

    it('handles whitespace between # and directive keyword', () => {
        const doc = makeDoc(['   #   ifdef DEBUG']);
        // 'ifdef' starts after "   #   " (7 chars)
        const ctx = detectDirectiveContext(doc, makePos(0, 8));
        expect(ctx?.directive).toBe('ifdef');
        expect(ctx?.onDirectiveName).toBe(true);
    });

    it('detects `#include` as a directive', () => {
        const doc = makeDoc(['#include <vector>']);
        const ctx = detectDirectiveContext(doc, makePos(0, 1));
        expect(ctx?.directive).toBe('include');
        expect(ctx?.onDirectiveName).toBe(true);
    });

    it('cursor at end of directive keyword (exclusive boundary) is not onDirectiveName', () => {
        // `#if` — 'if' is at cols [1, 3). Col 3 is past the keyword.
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 3));
        expect(ctx?.directive).toBe('if');
        expect(ctx?.onDirectiveName).toBe(false);
    });

    it('cursor at first char of directive keyword is onDirectiveName', () => {
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 1));
        expect(ctx?.onDirectiveName).toBe(true);
    });

    it('cursor at last char of directive keyword is onDirectiveName', () => {
        // '#if' — 'f' is at col 2, keyword is [1, 3)
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 2));
        expect(ctx?.onDirectiveName).toBe(true);
    });

    // -----------------------------------------------------------------
    // Cursor on the `#` itself and on whitespace between `#` and keyword
    // should both count as on the directive name. Without this, hovering
    // the `#` produces nothing because `#` isn't part of the C/C++ word
    // pattern, and hovering the gap between `#` and the keyword would
    // similarly silently miss.
    // -----------------------------------------------------------------
    it('treats cursor on the `#` character as on the directive name', () => {
        const doc = makeDoc(['#if NDEBUG']);
        const ctx = detectDirectiveContext(doc, makePos(0, 0));
        expect(ctx?.directive).toBe('if');
        expect(ctx?.onDirectiveName).toBe(true);
    });

    it('treats cursor on whitespace between `#` and keyword as on the directive name', () => {
        const doc = makeDoc(['#   ifdef DEBUG']);
        for (const col of [1, 2, 3]) {
            const ctx = detectDirectiveContext(doc, makePos(0, col));
            expect(ctx?.directive, `col ${col}`).toBe('ifdef');
            expect(ctx?.onDirectiveName, `col ${col}`).toBe(true);
        }
    });

    it('keeps cursor on operand as NOT on directive name', () => {
        const doc = makeDoc(['#if NDEBUG']);
        // 'NDEBUG' starts at column 4 (after '#if ')
        const ctx = detectDirectiveContext(doc, makePos(0, 4));
        expect(ctx?.directive).toBe('if');
        expect(ctx?.onDirectiveName).toBe(false);
    });

    // -----------------------------------------------------------------
    // C++23 / C23 conditional and embed directives. The regex already
    // captures these (\w+ matches the names) — these tests pin the
    // behavior so a future indexer rule rename or regex tweak that
    // accidentally drops them gets caught immediately.
    // -----------------------------------------------------------------
    for (const d of ['elifdef', 'elifndef', 'embed']) {
        it(`recognizes #${d} (C++23/C23 addition)`, () => {
            const doc = makeDoc([`#${d} FOO`]);
            const ctx = detectDirectiveContext(doc, makePos(0, 1));
            expect(ctx?.directive).toBe(d);
            expect(ctx?.onDirectiveName).toBe(true);
        });
    }

    it('tolerates a tab between # and directive keyword', () => {
        const doc = makeDoc(['#\tdefine FOO 1']);
        const ctx = detectDirectiveContext(doc, makePos(0, 2)); // 'd' of 'define'
        expect(ctx?.directive).toBe('define');
        expect(ctx?.onDirectiveName).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// wrapWithDirectiveAwareness
// ---------------------------------------------------------------------------

describe('wrapWithDirectiveAwareness', () => {
    it('delegates to inner on non-directive lines', async () => {
        const doc = makeDoc(['int x = some_symbol;']);
        const { inner, calls } = makeInner({ fqn: 'some_symbol' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 10));
        expect(result?.fqn).toBe('some_symbol');
        expect(calls.count).toBe(1);
    });

    it('resolves cursor-on-`if` in `#if NDEBUG` to the if Directive — not C++ keyword', async () => {
        // This is the primary regression test: the keyword strategy would
        // otherwise return the C++ `if` keyword page.
        const doc = makeDoc(['#if NDEBUG']);
        const { inner, calls } = makeInner({ fqn: 'if' }); // inner would return C++ if keyword
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'if' (col 1)
        const result = await wrapped.resolve(doc, makePos(0, 1));
        expect(result?.fqn).toBe('if');
        // Inner must not be called — wrapper short-circuited
        expect(calls.count).toBe(0);
    });

    it('falls through for cursor on `NDEBUG` in `#if NDEBUG`', async () => {
        const doc = makeDoc(['#if NDEBUG']);
        const { inner, calls } = makeInner({ fqn: 'NDEBUG' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'NDEBUG' (col 4)
        const result = await wrapped.resolve(doc, makePos(0, 4));
        expect(result?.fqn).toBe('NDEBUG');
        expect(calls.count).toBe(1);
    });

    it('resolves `#pragma` cursor-on-pragma to the pragma Directive', async () => {
        const doc = makeDoc(['#pragma once']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 2));
        expect(result?.fqn).toBe('pragma');
        expect(calls.count).toBe(0);
    });

    it('resolves `#pragma once` cursor-on-`once` to the pragma Directive page', async () => {
        // The user is pointing at `once` but the correct docs page is #pragma,
        // since `once` by itself has no dedicated page.
        const doc = makeDoc(['#pragma once']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'once' (col 9)
        const result = await wrapped.resolve(doc, makePos(0, 9));
        expect(result?.fqn).toBe('pragma');
        expect(calls.count).toBe(0);
    });

    it('resolves `#pragma GCC optimize` cursor-on-GCC to the pragma Directive page', async () => {
        const doc = makeDoc(['#pragma GCC optimize("O3")']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'GCC' (col 8)
        const result = await wrapped.resolve(doc, makePos(0, 8));
        expect(result?.fqn).toBe('pragma');
        expect(calls.count).toBe(0);
    });

    it('resolves cursor-on-`define` in `#define FOO 1` to the define Directive', async () => {
        const doc = makeDoc(['#define FOO 1']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 2));
        expect(result?.fqn).toBe('define');
        expect(calls.count).toBe(0);
    });

    it('falls through for cursor on `FOO` operand in `#define FOO 1`', async () => {
        const doc = makeDoc(['#define FOO 1']);
        const { inner, calls } = makeInner({ fqn: 'FOO' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'FOO' (col 9)
        const result = await wrapped.resolve(doc, makePos(0, 9));
        expect(result?.fqn).toBe('FOO');
        expect(calls.count).toBe(1);
    });

    it('falls through for `#include` lines — wrapWithIncludeAwareness owns these', async () => {
        const doc = makeDoc(['#include <vector>']);
        const { inner, calls } = makeInner({ fqn: 'vector' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'include' keyword
        const result = await wrapped.resolve(doc, makePos(0, 2));
        expect(result?.fqn).toBe('vector');
        expect(calls.count).toBe(1);
    });

    it('falls through for `#include` cursor on header name', async () => {
        const doc = makeDoc(['#include <vector>']);
        const { inner, calls } = makeInner({ fqn: 'vector' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        // Cursor on 'vector' inside <...>
        const result = await wrapped.resolve(doc, makePos(0, 11));
        expect(calls.count).toBe(1);
        expect(result?.fqn).toBe('vector');
    });

    it('falls through when directive name has no Directive-kind index entry', async () => {
        // If the DB doesn't have a Directive entry for this keyword, don't
        // block the chain — maybe another strategy can help.
        const doc = makeDoc(['#if COND']);
        const { inner, calls } = makeInner({ fqn: 'if' });
        const emptyIndex = makeIndex({}); // nothing in DB
        const wrapped = wrapWithDirectiveAwareness(inner, emptyIndex);
        const result = await wrapped.resolve(doc, makePos(0, 1));
        expect(calls.count).toBe(1);
        expect(result?.fqn).toBe('if');
    });

    it('falls through when directive name matches a non-Directive-kind entry', async () => {
        // Sanity: if `if` somehow had kind=Keyword in the index, don't use it.
        const doc = makeDoc(['#if COND']);
        const { inner, calls } = makeInner({ fqn: 'if' });
        const wrongKind = makeIndex({ if: { kind: 'Keyword' } });
        const wrapped = wrapWithDirectiveAwareness(inner, wrongKind);
        const result = await wrapped.resolve(doc, makePos(0, 1));
        expect(calls.count).toBe(1);
    });

    it('resolves cursor-on-`ifdef` to the ifdef Directive', async () => {
        const doc = makeDoc(['#ifdef DEBUG']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 2));
        expect(result?.fqn).toBe('ifdef');
        expect(calls.count).toBe(0);
    });

    it('resolves cursor-on-`error` to the error Directive', async () => {
        const doc = makeDoc(['#error "not supported"']);
        const { inner, calls } = makeInner(undefined);
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 3));
        expect(result?.fqn).toBe('error');
        expect(calls.count).toBe(0);
    });

    it('preserves the inner resolver strategyOrder', () => {
        const inner: Resolver = {
            strategyOrder: ['keyword', 'clangd', 'hover', 'definition', 'fallback'],
            resolve: vi.fn()
        };
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        expect(wrapped.strategyOrder).toEqual([
            'keyword',
            'clangd',
            'hover',
            'definition',
            'fallback'
        ]);
    });

    // ---------------------------------------------------------------------
    // Non-collision contract. Cursor on the plain C++ `if` / `else` keyword
    // (no `#`) MUST delegate to the inner resolver chain unmodified — never
    // short-circuit to the directive page. The whitespace variant goes the
    // other way: `#  if X` MUST resolve to the directive even though the
    // inner chain's keyword strategy would also pick up `if`.
    // ---------------------------------------------------------------------
    it('does not short-circuit on the C++ `if` keyword in plain code', async () => {
        const doc = makeDoc(['if (x > 0) {']);
        const { inner, calls } = makeInner({ fqn: 'inner-result' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 0));
        expect(result?.fqn).toBe('inner-result');
        expect(calls.count).toBe(1);
    });

    it('does not short-circuit on the C++ `else` keyword in plain code', async () => {
        const doc = makeDoc(['} else {']);
        const { inner, calls } = makeInner({ fqn: 'inner-result' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 2));
        expect(result?.fqn).toBe('inner-result');
        expect(calls.count).toBe(1);
    });

    it('does not confuse `#  if X` with the C++ if keyword', async () => {
        const doc = makeDoc(['#  if X']);
        const { inner, calls } = makeInner({ fqn: 'WRONG-cpp-keyword-result' });
        const wrapped = wrapWithDirectiveAwareness(inner, makeIndex(DIRECTIVES));
        const result = await wrapped.resolve(doc, makePos(0, 3));
        expect(result?.fqn).toBe('if');
        expect(calls.count).toBe(0);
    });
});
