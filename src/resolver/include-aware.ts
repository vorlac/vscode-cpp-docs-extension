// Include-context awareness wrapper for the composed resolver.
//
// Problem: the cursor-position fallback strategy doesn't know it's
// inside an `#include` directive — it just sees the bare word at the
// cursor (e.g. `concepts` inside `#include "core/concepts.hpp"`) and
// happily resolves it through `lookupExact`, matching the stdlib
// `<concepts>` header page even though the user is pointing at a
// project-local header that has nothing to do with C++20 concepts.
//
// This wrapper sits OUTSIDE the LRU cache (so cached hits don't bypass
// the guard) and intercepts include lines before any strategy runs:
//
//   - `#include "..."`  (user-local include) — always returns
//     undefined. Project-local headers never have cppreference pages,
//     so matching anything would be misleading; sticky panel behavior
//     is the correct outcome.
//
//   - `#include <X>`    (system include) — restricts the result to a
//     Header-kind row whose `qualified_name` exactly matches `X`.
//     Falls back to undefined when the bracket content doesn't match
//     a known stdlib header (e.g. `<stdio.h>`, `<bits/stl_vector.h>`,
//     or any vendor extension); the user gets sticky panel rather than
//     an unrelated docs page.
//
// Pre-strategy resolvers were considered, but the resolver chain
// returns `undefined` to mean "continue to the next strategy". There's
// no way for a high-priority strategy to definitively short-circuit
// the chain. A wrapper around the entire composed resolver gives us
// that authority cleanly.

import type * as vscode from 'vscode';
import type { ResolvedSymbol, Resolver } from './types.js';

/**
 * Minimal index surface required by the include-aware wrapper. Mirrors
 * the `Pick<>` pattern other resolver strategies use so tests can stub
 * with a tiny object.
 *
 * `lookupHeader` must return a row ONLY when the index has a
 * `kind = 'Header'` entry for the given name. A plain `lookupExact` is
 * insufficient because multiple rows can share the same `qualified_name`
 * with different kinds (e.g. `array` exists as both a `Language` row
 * for the C++ array-type page and a `Header` row for `<array>`); the
 * ORDER BY tiebreaker in `lookupExact` is ambiguous when lengths are
 * equal, so the wrong kind can be returned.
 */
export interface IncludeAwareIndex {
    lookupHeader(qualifiedName: string): { kind: string } | undefined;
}

export type IncludeContext =
    | { kind: 'quoted'; name: string }
    | { kind: 'system'; name: string };

/**
 * Detect whether `position` sits on an `#include` directive line, and
 * return the directive's flavor + the header path/name. Returns
 * `undefined` for any other line.
 *
 * The check is line-based rather than column-based: it doesn't matter
 * whether the cursor is on the `#`, the `include` keyword, inside the
 * brackets/quotes, or even past the closing delimiter — once we know
 * the line is an include we don't want to perform symbol lookups
 * anywhere on it.
 */
export function detectIncludeContext(
    document: Pick<vscode.TextDocument, 'lineAt'>,
    position: Pick<vscode.Position, 'line'>
): IncludeContext | undefined {
    let line: string;
    try {
        line = document.lineAt(position.line).text;
    } catch {
        return undefined;
    }
    const sys = /^\s*#\s*include\s*<([^>]+)>/.exec(line);
    if (sys && sys[1] !== undefined) {
        return { kind: 'system', name: sys[1] };
    }
    const local = /^\s*#\s*include\s*"([^"]+)"/.exec(line);
    if (local && local[1] !== undefined) {
        return { kind: 'quoted', name: local[1] };
    }
    return undefined;
}

/**
 * Wrap a resolver so include-context detection runs before the inner
 * chain. Quoted includes always short-circuit to undefined; system
 * includes resolve via an exact Header-kind match against the index.
 */
export function wrapWithIncludeAwareness(
    inner: Resolver,
    index: IncludeAwareIndex
): Resolver {
    return {
        strategyOrder: inner.strategyOrder,
        async resolve(
            document: vscode.TextDocument,
            position: vscode.Position
        ): Promise<ResolvedSymbol | undefined> {
            const ctx = detectIncludeContext(document, position);
            if (!ctx) return inner.resolve(document, position);
            if (ctx.kind === 'quoted') {
                // Project-local include — never look up anything. Don't even
                // try the inner chain; some strategies (fallback) would happily
                // match the trailing identifier against a same-named stdlib
                // page, and that's the bug we're fixing.
                return undefined;
            }
            // System include. The bracket content is the canonical
            // identifier for stdlib headers (`vector`, `cstdio`, `concepts`,
            // ...). Accept only when the index has a Header-kind entry for
            // it; everything else (`<stdio.h>`, `<bits/...>`, third-party
            // headers) bails to sticky.
            //
            // `lookupHeader` (not `lookupExact`) is intentional: multiple
            // rows can share the same qualified_name with different kinds.
            // For example, `array` has both a Language row (C++ array-type
            // docs) and a Header row (<array>). A plain lookupExact returns
            // whichever row SQLite picks first — non-deterministically —
            // so we pin kind='Header' at the query level instead of
            // post-filtering the arbitrary result.
            const hit = index.lookupHeader(ctx.name);
            if (!hit) {
                return undefined;
            }
            return { fqn: ctx.name };
        }
    };
}
