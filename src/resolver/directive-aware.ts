// Preprocessor-directive awareness wrapper for the composed resolver.
//
// Problem: `getWordRangeAtPosition` with `/[A-Za-z_]\w*/` never captures
// the leading `#`, so cursor-on-`if` inside `#if NDEBUG` looks identical
// to cursor-on-`if` in a plain C++ `if` statement. The keyword strategy
// would always win, routing the user to the C++ `if` keyword page instead
// of the preprocessor `#if` directive page.
//
// A symmetric problem exists for `#pragma once`: cursor-on-`once` produces
// the bare token `once`, which matches nothing and yields a miss, even
// though the user clearly wants the `#pragma` docs page.
//
// This wrapper sits OUTERMOST (wrapping include-awareness, which wraps the
// cache, which wraps the composed chain) and intercepts before any strategy
// runs:
//
//   - Cursor on the directive keyword (`if`, `define`, `pragma`, …) →
//     short-circuit to the Directive-kind DB entry. The keyword strategy
//     would otherwise return the C++ keyword page for `if`, `while`, etc.
//
//   - Cursor anywhere in a `#pragma …` line (e.g. `once` in `#pragma once`)
//     → also resolves to the `pragma` Directive page; `once` by itself has
//     no meaningful lookup and the user wants the pragma docs.
//
//   - Cursor on operands (`NDEBUG` in `#if NDEBUG`, `FOO` in `#define FOO`)
//     → falls through to inner chain so the symbol resolves normally.
//
//   - `#include` lines → fall through; `wrapWithIncludeAwareness` handles
//     the cursor-in-angle-bracket / cursor-on-include-keyword cases.

import type * as vscode from 'vscode';
import type { ResolvedSymbol, Resolver } from './types.js';

/**
 * Result of `detectDirectiveContext`. Callers that need only the directive
 * name and whether the cursor sits on it can destructure directly.
 */
export interface DirectiveContext {
    /** The bare directive keyword, e.g. `'if'`, `'pragma'`, `'define'`. */
    directive: string;
    /** True when `position.character` falls on the directive keyword itself. */
    onDirectiveName: boolean;
}

/**
 * Minimal index surface required by the directive-aware wrapper. Mirrors the
 * `Pick<>` pattern used by `IncludeAwareIndex` so tests can stub cheaply.
 */
export interface DirectiveAwareIndex {
    lookupExact(qualifiedName: string): { kind: string } | undefined;
}

/**
 * Detect whether `position` sits on a preprocessor directive line and, if so,
 * return the directive name and whether the cursor is over the directive
 * keyword itself.
 *
 * The function reads only the single line at `position.line`; column analysis
 * is purely character-index arithmetic on the matched string.
 *
 * Returns `undefined` when the line is not a preprocessor directive.
 */
export function detectDirectiveContext(
    document: Pick<vscode.TextDocument, 'lineAt'>,
    position: Pick<vscode.Position, 'line' | 'character'>
): DirectiveContext | undefined {
    let line: string;
    try {
        line = document.lineAt(position.line).text;
    } catch {
        return undefined;
    }

    // Match `# <whitespace>? <directive-keyword>` anchored at the start of
    // the line (modulo leading whitespace).
    const match = /^\s*#\s*(\w+)/.exec(line);
    if (!match || !match[1]) return undefined;

    const directive = match[1];

    // The directive keyword occupies [directiveStart, directiveEnd) in the
    // line string. `match[0]` is the full match ("  #  if"); the keyword
    // itself is the final `match[1].length` characters of that span. We
    // extend "on the directive name" leftward to include the `#` and any
    // whitespace between `#` and the keyword: the `#` isn't part of the
    // C/C++ word pattern (so it can't resolve as a standalone token), and
    // a hover on the gap clearly means the directive. Cursor on operands
    // (e.g. `NDEBUG` in `#if NDEBUG`) still falls past `directiveEnd` and
    // is handled by the inner resolver chain.
    const hashIndex = line.indexOf('#');
    const directiveEnd = match[0].length;
    const onDirectiveName =
        position.character >= hashIndex && position.character < directiveEnd;

    return { directive, onDirectiveName };
}

/**
 * Wrap a resolver so preprocessor-directive detection runs before the inner
 * chain. Short-circuits to the matching Directive-kind DB entry when
 * appropriate; falls through for operand tokens and `#include` lines.
 */
export function wrapWithDirectiveAwareness(
    inner: Resolver,
    index: DirectiveAwareIndex
): Resolver {
    return {
        strategyOrder: inner.strategyOrder,
        async resolve(
            document: vscode.TextDocument,
            position: vscode.Position
        ): Promise<ResolvedSymbol | undefined> {
            const ctx = detectDirectiveContext(document, position);
            if (!ctx) return inner.resolve(document, position);

            // Let wrapWithIncludeAwareness own all #include handling.
            if (ctx.directive === 'include') return inner.resolve(document, position);

            // Resolve to the directive page when:
            //   (a) cursor is on the directive keyword itself, OR
            //   (b) cursor is anywhere on a #pragma line — any sub-token of a
            //       pragma statement (e.g. `once`, `GCC`, `STDC`) is best
            //       served by the generic pragma docs page.
            if (ctx.onDirectiveName || ctx.directive === 'pragma') {
                const hit = index.lookupExact(ctx.directive);
                if (hit?.kind === 'Directive') {
                    return { fqn: ctx.directive };
                }
            }

            // Cursor is on an operand (e.g. NDEBUG in `#if NDEBUG`, or FOO
            // in `#define FOO 1`). Let the inner chain resolve it as a normal
            // symbol.
            return inner.resolve(document, position);
        }
    };
}
