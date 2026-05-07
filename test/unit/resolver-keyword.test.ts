// Unit tests for the keyword strategy + `isOnEllipsis` helper in
// `src/resolver/keyword.ts`.
//
// The keyword strategy runs FIRST in the resolver chain so that
// keywords like `static` / `inline` / `constexpr` / `using` resolve to
// their own docs pages instead of being hijacked by the surrounding
// declaration's hover content. The ellipsis path (`...`) is detected by
// inspecting the document text directly because `getWordRangeAtPosition`
// doesn't fire on punctuation.
//
// Three behaviors under test:
//   1. `isOnEllipsis(document, position)` — pure-ish helper that reads
//      one line of the document text and decides whether the cursor
//      sits on a `...` run. Tests cover the middle / first / last dot,
//      the negative case of `.` (member access) or `..`, and the
//      defensive `lineAt` throw-path.
//   2. `createKeywordStrategy({index})` returning the strategy contract.
//      Tests cover: no-word, ellipsis hit (parameter_pack), ellipsis
//      miss, keyword with Keyword-kind index hit, keyword with Language-
//      kind index hit, keyword with no index hit, keyword with
//      unrelated-kind hit, non-keyword identifier (skip), aborted
//      signal on entry, and a custom `wordPattern`.
//
// Like the M4 fallback suite (test/unit/resolver-fallback.test.ts), the
// vscode types are duck-typed via a `makeDoc({ text, word })` helper and
// the index dependency uses `vi.fn()` mocks so we can assert call
// patterns precisely.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    createKeywordStrategy,
    isOnEllipsis,
    type KeywordResolverIndex
} from '../../src/resolver/keyword.js';
import type { ResolveContext } from '../../src/resolver/types.js';

// ---- isOnEllipsis ---------------------------------------------------

describe('isOnEllipsis', () => {
    function lineDoc(line: string): Pick<vscode.TextDocument, 'lineAt'> {
        return {
            lineAt: ((arg: number | vscode.Position) => {
                const n = typeof arg === 'number' ? arg : arg.line;
                if (n !== 0) throw new RangeError('line out of range');
                return { text: line } as unknown as vscode.TextLine;
            }) as Pick<vscode.TextDocument, 'lineAt'>['lineAt']
        };
    }
    function pos(character: number, line = 0): vscode.Position {
        return { line, character } as unknown as vscode.Position;
    }

    it('returns true on the middle `.` of `...`', () => {
        // `template<class... Args>` — cursor on column 14 (the second dot
        // of the three-dot run after `class`).
        const doc = lineDoc('template<class... Args>');
        // The three dots are at columns 14, 15, 16. Middle is 15.
        expect(isOnEllipsis(doc, pos(15))).toBe(true);
    });

    it('returns true on the first `.` of a `...` run', () => {
        const doc = lineDoc('template<class... Args>');
        expect(isOnEllipsis(doc, pos(14))).toBe(true);
    });

    it('returns true on the last `.` of a `...` run', () => {
        const doc = lineDoc('template<class... Args>');
        expect(isOnEllipsis(doc, pos(16))).toBe(true);
    });

    it('returns true for `Args...` parameter-pack expansion', () => {
        // `f(args...)` — three dots at the end of the call.
        const doc = lineDoc('return f(args...);');
        // `args...` — dots at columns 13, 14, 15.
        expect(isOnEllipsis(doc, pos(13))).toBe(true);
        expect(isOnEllipsis(doc, pos(14))).toBe(true);
        expect(isOnEllipsis(doc, pos(15))).toBe(true);
    });

    it('returns false for a single `.` (member access)', () => {
        // `vec.data();` — the `.` is at column 3, alone. Not an ellipsis.
        const doc = lineDoc('vec.data();');
        expect(isOnEllipsis(doc, pos(3))).toBe(false);
    });

    it('returns false for two adjacent dots `..` (rare but legal in raw strings)', () => {
        const doc = lineDoc('a..b');
        expect(isOnEllipsis(doc, pos(1))).toBe(false);
        expect(isOnEllipsis(doc, pos(2))).toBe(false);
    });

    it('returns false on a non-dot character with no adjacent dot run', () => {
        const doc = lineDoc('Args... rest;');
        // The `A` of `Args` (column 0) — not a dot, and no dot at col -1.
        expect(isOnEllipsis(doc, pos(0))).toBe(false);
        // The `s` of `Args` (column 3) — not a dot. Col 2 is `g`. No dots.
        expect(isOnEllipsis(doc, pos(3))).toBe(false);
        // The `r` of `rest` (column 8) — not a dot. Col 7 is space. No dots.
        expect(isOnEllipsis(doc, pos(8))).toBe(false);
        // The `e` of `rest` (column 9) — not a dot. Col 8 is `r`. No dots.
        expect(isOnEllipsis(doc, pos(9))).toBe(false);
    });

    it('treats the cursor column adjacent to the ellipsis as on the ellipsis (caret-between convention)', () => {
        // VSCode's caret can sit between characters; the implementation
        // checks BOTH `position.character` and `position.character - 1` as
        // candidates. For `Args...`, the column just past the last `.`
        // (column 7 in `Args... rest;`) has column 6 as a candidate, and
        // column 6 is the last dot of a 3-dot run — so the cursor "between"
        // the dots and the space is still considered on the ellipsis.
        const doc = lineDoc('Args... rest;');
        expect(isOnEllipsis(doc, pos(7))).toBe(true);
        // Column 4 — caret between `s` and the first dot — has col 3 (`s`)
        // and col 4 (first dot) as candidates. Col 4 is `.` with a 3-run.
        expect(isOnEllipsis(doc, pos(4))).toBe(true);
    });

    it('returns false when cursor.line is out of range (lineAt throws)', () => {
        // The helper's try/catch swallows the RangeError our shim throws.
        const doc = lineDoc('first line');
        expect(isOnEllipsis(doc, pos(0, 99))).toBe(false);
    });

    it('returns false when cursor.character is past the end of the line', () => {
        const doc = lineDoc('abc');
        // Cursor at column 100 — out of bounds. Helper should not crash.
        expect(isOnEllipsis(doc, pos(100))).toBe(false);
    });

    it('returns false on an empty line', () => {
        const doc = lineDoc('');
        expect(isOnEllipsis(doc, pos(0))).toBe(false);
    });
});

// ---- createKeywordStrategy ------------------------------------------

interface ShimRange {
    __range: true;
}

interface ShimDocOpts {
    text: string;
    /** word that getWordRangeAtPosition returns; undefined → no range. */
    word: string | undefined;
}

function makeDoc(opts: ShimDocOpts): vscode.TextDocument {
    const lines = opts.text.split('\n');
    const range: ShimRange = { __range: true };
    const doc = {
        uri: { toString: (): string => 'file:///tmp/x.cpp' },
        version: 1,
        languageId: 'cpp',
        lineCount: lines.length,
        lineAt: (n: number): vscode.TextLine => {
            const text = lines[n] ?? '';
            return { text } as unknown as vscode.TextLine;
        },
        getText: (r?: vscode.Range): string => {
            if (r === undefined) return opts.text;
            return opts.word ?? '';
        },
        getWordRangeAtPosition: (
            _p: vscode.Position,
            _re?: RegExp
        ): vscode.Range | undefined => {
            void _p;
            void _re;
            if (opts.word === undefined) return undefined;
            return range as unknown as vscode.Range;
        }
    } as unknown as vscode.TextDocument;
    return doc;
}

function makeContext(
    doc: vscode.TextDocument,
    line: number,
    character: number,
    signal?: AbortSignal
): ResolveContext {
    const position = { line, character } as unknown as vscode.Position;
    return {
        document: doc,
        position,
        signal: signal ?? new AbortController().signal
    };
}

/**
 * Build a stub `KeywordResolverIndex`. The strategy reads `kind`,
 * `qualifiedName`, and `filePath` from the returned row — short
 * test shapes auto-fill `qualifiedName=name` and `filePath` derived
 * from `kind` so most tests can omit those fields.
 */
function makeIndex(
    rows: Record<
        string,
        | { kind: string; qualifiedName?: string; filePath?: string }
        | undefined
    >
): KeywordResolverIndex {
    return {
        lookupExact: vi.fn((name: string) => {
            const row = rows[name];
            if (!row) return undefined;
            return {
                kind: row.kind,
                qualifiedName: row.qualifiedName ?? name,
                filePath:
                    row.filePath ??
                    (row.kind === 'Keyword'
                        ? `en/cpp/keyword/${name}.html`
                        : row.kind === 'Language'
                            ? `en/cpp/language/${name}.html`
                            : `en/cpp/utility/${name}.html`)
            };
        })
    };
}

describe('createKeywordStrategy', () => {
    it('returns undefined when there is no word range AND no ellipsis at cursor', async () => {
        const doc = makeDoc({ text: '   \n', word: undefined });
        const index = makeIndex({});
        const strategy = createKeywordStrategy({ index });
        expect(await strategy(makeContext(doc, 0, 0))).toBeUndefined();
        // No lookup should have happened — neither the ellipsis (parameter_pack)
        // nor the keyword paths fire when there's nothing under the cursor.
        expect(index.lookupExact).not.toHaveBeenCalled();
    });

    it('returns parameter_pack when cursor is on `...` and the index has the page', async () => {
        // Cursor on the middle dot of `...`. `getWordRangeAtPosition` would
        // return undefined for a `.`, but the ellipsis path detects it
        // before the word lookup.
        const doc = makeDoc({
            text: 'template<class... Args>',
            word: undefined
        });
        const index = makeIndex({
            parameter_pack: { kind: 'Language' }
        });
        const strategy = createKeywordStrategy({ index });
        // Column 15 is the middle of `...` (columns 14/15/16 in this string).
        const result = await strategy(makeContext(doc, 0, 15));
        expect(result).toEqual({ fqn: 'parameter_pack', source: 'keyword' });
        expect(index.lookupExact).toHaveBeenCalledWith('parameter_pack');
    });

    it('returns undefined for ellipsis when parameter_pack is missing from the index', async () => {
        const doc = makeDoc({
            text: 'template<class... Args>',
            word: undefined
        });
        const index = makeIndex({}); // no parameter_pack row
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 15));
        expect(result).toBeUndefined();
        expect(index.lookupExact).toHaveBeenCalledWith('parameter_pack');
    });

    it('resolves a keyword when the index has a Keyword-kind row', async () => {
        // Cursor on `static`. The index's `static` entry has kind=Keyword
        // (the dedicated `cpp/keyword/static.html` page).
        const doc = makeDoc({
            text: 'static constexpr int x = 0;',
            word: 'static'
        });
        const index = makeIndex({
            static: { kind: 'Keyword' }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 3));
        expect(result).toEqual({ fqn: 'static', source: 'keyword' });
        expect(index.lookupExact).toHaveBeenCalledWith('static');
    });

    it('resolves a keyword when the index has a Language-kind row', async () => {
        // cppreference often ships TWO rows per keyword:
        // `cpp/keyword/<kw>` (Keyword) and `cpp/language/<kw>` (Language).
        // Either kind should satisfy the strategy.
        const doc = makeDoc({
            text: 'if (x) y;',
            word: 'if'
        });
        const index = makeIndex({
            if: { kind: 'Language' }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 0));
        expect(result).toEqual({ fqn: 'if', source: 'keyword' });
    });

    it('returns undefined for a keyword with no index hit at all', async () => {
        // Ancient cppreference dump that doesn't carry a row for the
        // keyword. The strategy must not invent an FQN that downstream
        // lookupBest would then miss on; instead it lets the chain proceed.
        const doc = makeDoc({
            text: 'co_yield value;',
            word: 'co_yield'
        });
        const index = makeIndex({}); // no co_yield row
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 0));
        expect(result).toBeUndefined();
        expect(index.lookupExact).toHaveBeenCalledWith('co_yield');
    });

    it('returns undefined when the index hit has an unrelated kind (e.g. `Function`)', async () => {
        // Defensive — the strategy MUST only return for Keyword/Language
        // entries. If the index happens to carry a Function row whose
        // qualified name collides with a keyword (unlikely but possible
        // for an upstream curator mistake), we don't surface it.
        const doc = makeDoc({
            text: 'requires x;',
            word: 'requires'
        });
        const index = makeIndex({
            requires: { kind: 'Function' }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 0));
        expect(result).toBeUndefined();
    });

    // Regression: cppreference's 2025-02-09 dump ships a handful of
    // keyword pages under non-standard subdirectories — `typename`,
    // `module`, `import` live in `en/cpp/keywords/` (plural) or
    // `en/cpp/identifier_with_special_meaning/`. The indexer's older
    // path-prefix rules used singular `cpp/keyword/`, so these pages
    // fell through to the catch-all `en/cpp/` rule and got recorded as
    // `std::typename` / `std::module` / `std::import` with kind=Function.
    // The keyword strategy MUST handle both correctly-indexed and
    // misindexed shapes — the resolver fix ships with the indexer fix
    // so users on already-installed docsets don't need to reinstall.
    it('resolves misindexed keyword (typename) via std:: fallback + filePath check', async () => {
        const doc = makeDoc({ text: 'typename T::value v;', word: 'typename' });
        const index = makeIndex({
            // Bare lookup misses (this is the bug shape).
            // The misindexed row sits under `std::typename` with kind=Function.
            'std::typename': {
                kind: 'Function',
                qualifiedName: 'std::typename',
                filePath: 'en/cpp/keywords/typename.html'
            }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 4));
        // Must return the qualifiedName the index has on file so the
        // cursor-follow handler's `lookupBest` can find the page.
        expect(result).toEqual({ fqn: 'std::typename', source: 'keyword' });
        // The strategy tried the bare name first, then `std::<word>`.
        expect(index.lookupExact).toHaveBeenNthCalledWith(1, 'typename');
        expect(index.lookupExact).toHaveBeenNthCalledWith(2, 'std::typename');
    });

    it('resolves misindexed keyword via identifier_with_special_meaning path', async () => {
        // `module`, `import`, `final`, `override` live under
        // `en/cpp/identifier_with_special_meaning/`. The path is in a
        // language / keyword bucket even though the directory name
        // doesn't match. The filePath regex in `isKeywordHit` is what
        // catches this — we accept any path containing `/keyword/`,
        // `/keywords/`, or `/language/`. But this specific directory is
        // covered by the indexer fix, not the resolver tolerance — so
        // by the time it reaches the resolver the row should already
        // be bare `module` with kind=Keyword.
        const doc = makeDoc({ text: 'export module foo;', word: 'module' });
        const index = makeIndex({
            module: {
                kind: 'Keyword',
                filePath: 'en/cpp/identifier_with_special_meaning/module.html'
            }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 9));
        expect(result).toEqual({ fqn: 'module', source: 'keyword' });
    });

    it('rejects misindexed std:: hit when filePath is in an unrelated dir', async () => {
        // Defensive: if some future indexer regression puts `std::<keyword>`
        // pointing at, say, `cpp/utility/typename.html`, the strategy must
        // NOT mistake it for a keyword. Only paths under
        // keyword(s)/language/ qualify.
        const doc = makeDoc({ text: 'typename T::value v;', word: 'typename' });
        const index = makeIndex({
            'std::typename': {
                kind: 'Function',
                qualifiedName: 'std::typename',
                filePath: 'en/cpp/utility/typename.html'
            }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 4));
        expect(result).toBeUndefined();
    });

    it('returns undefined for a non-keyword identifier and does not call lookupExact', async () => {
        // The hot-path: cursor on an ordinary identifier. The strategy
        // must bail out cleanly so the chain proceeds.
        const doc = makeDoc({
            text: 'std::apply(f, t);',
            word: 'apply'
        });
        const index = makeIndex({
            apply: { kind: 'Function' }
        });
        const strategy = createKeywordStrategy({ index });
        const result = await strategy(makeContext(doc, 0, 5));
        expect(result).toBeUndefined();
        // The keyword strategy must short-circuit before consulting the
        // index for a non-keyword token, otherwise every cursor move would
        // hit the DB for nothing.
        expect(index.lookupExact).not.toHaveBeenCalled();
    });

    it('returns undefined when the abort signal is already fired on entry', async () => {
        const doc = makeDoc({
            text: 'static int x = 0;',
            word: 'static'
        });
        const index = makeIndex({
            static: { kind: 'Keyword' }
        });
        const strategy = createKeywordStrategy({ index });
        const controller = new AbortController();
        controller.abort();
        // The keyword strategy chose to RETURN UNDEFINED for abort, not
        // throw — see the M-4 fix in keyword.ts where the early return
        // `if (ctx.signal.aborted) return undefined;` is the first
        // statement of the strategy.
        const result = await strategy(makeContext(doc, 0, 0, controller.signal));
        expect(result).toBeUndefined();
        // The strategy short-circuited before any index access.
        expect(index.lookupExact).not.toHaveBeenCalled();
    });

    it('honors a custom wordPattern (passed-through to getWordRangeAtPosition)', async () => {
        // A pattern that captures no word — the strategy receives undefined
        // from getWordRangeAtPosition and falls through to undefined.
        let receivedPattern: RegExp | undefined;
        const customPattern = /[A-Z][A-Za-z]*/;
        const doc = {
            uri: { toString: (): string => 'file:///tmp/x.cpp' },
            version: 1,
            languageId: 'cpp',
            lineCount: 1,
            lineAt: () => ({ text: 'static int x = 0;' }) as unknown as vscode.TextLine,
            getText: (): string => '',
            getWordRangeAtPosition: (
                _p: vscode.Position,
                re?: RegExp
            ): vscode.Range | undefined => {
                receivedPattern = re;
                return undefined; // signal "no word" so the strategy returns undefined
            }
        } as unknown as vscode.TextDocument;

        const index = makeIndex({});
        const strategy = createKeywordStrategy({ index, wordPattern: customPattern });
        const result = await strategy(makeContext(doc, 0, 0));
        expect(receivedPattern).toBe(customPattern);
        expect(result).toBeUndefined();
    });

    it('the strategy is constructible without a wordPattern (default is used)', async () => {
        // Smoke test: the documented default `/[A-Za-z_]\w*/` is applied
        // when the caller omits wordPattern. We can't observe the default
        // directly through the shim (getWordRangeAtPosition is opaque from
        // this side), but the strategy must still resolve a known keyword.
        const doc = makeDoc({
            text: 'static int x = 0;',
            word: 'static'
        });
        const index = makeIndex({ static: { kind: 'Keyword' } });
        const strategy = createKeywordStrategy({ index }); // no wordPattern
        const result = await strategy(makeContext(doc, 0, 0));
        expect(result?.fqn).toBe('static');
    });

    it('returns undefined for an empty extracted word', async () => {
        // Defensive: an upstream shim might return an empty string as the
        // word. The strategy must not treat that as a keyword match.
        const doc = makeDoc({ text: '   \n', word: '' });
        const index = makeIndex({ '': { kind: 'Keyword' } });
        const strategy = createKeywordStrategy({ index });
        expect(await strategy(makeContext(doc, 0, 0))).toBeUndefined();
        // No lookup should happen for an empty word.
        expect(index.lookupExact).not.toHaveBeenCalled();
    });
});
