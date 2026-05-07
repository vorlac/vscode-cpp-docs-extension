// Unit tests for the M4.4 fallback strategy (word + namespace
// heuristic). Per docs/03-symbol-resolution.md § "Strategy 4" and
// § "Disambiguation".
//
// Three layers:
//   1. `walkScopes` — pure brace-depth + scope-stack helper.
//   2. `buildFqnCandidates` — pure ordering + dedup helper.
//   3. `createFallbackStrategy` — end-to-end against a vscode shim and
//      a hand-rolled index mock.
//
// The strategy is the no-LSP path; nothing here imports clangd or the
// MS C/C++ exports surface, by design.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import type { IndexDB, SymbolHit } from '../../src/docset/index.js';
import {
    buildFqnCandidates,
    createFallbackStrategy,
    detectMemberAccess,
    walkScopes,
    type ScopeWalkResult
} from '../../src/resolver/fallback.js';
import type { ResolveContext } from '../../src/resolver/types.js';

// ---- walkScopes -----------------------------------------------------

describe('walkScopes', () => {
    function walk(src: string, cursorLine: number): ScopeWalkResult {
        return walkScopes({ lines: src.split('\n'), cursorLine });
    }

    it('returns empty scope at the top of a file with no namespaces', () => {
        const result = walk('int main() {\n  return 0;\n}\n', 1);
        expect(result.enclosingScopes).toEqual([]);
        expect(result.usingNamespaces).toEqual([]);
    });

    it('recognizes a single enclosing namespace', () => {
        const src = `namespace std {
  void sort();
}
`;
        const result = walk(src, 1);
        expect(result.enclosingScopes).toEqual(['std']);
    });

    it('recognizes nested namespaces', () => {
        const src = `namespace std {
  namespace detail {
    void sort();
  }
}
`;
        const result = walk(src, 2);
        expect(result.enclosingScopes).toEqual(['std', 'detail']);
    });

    it('handles C++17 nested namespace declaration on a single line', () => {
        const src = `namespace std::detail {
  void sort();
}
`;
        const result = walk(src, 1);
        expect(result.enclosingScopes).toEqual(['std', 'detail']);
    });

    it('drops scopes that close before the cursor line', () => {
        const src = `namespace std {
  void a();
}
namespace other {
  void b();
}
int main() {}
`;
        const result = walk(src, 6);
        expect(result.enclosingScopes).toEqual([]);
    });

    it('keeps the outer scope when a sibling closes', () => {
        const src = `namespace std {
  namespace a {
    void aa();
  }
  void here();
}
`;
        const result = walk(src, 4);
        expect(result.enclosingScopes).toEqual(['std']);
    });

    it('collects `using namespace` directives above the cursor', () => {
        const src = `using namespace std;
using namespace std::ranges;
int main() { sort(); }
`;
        const result = walk(src, 2);
        expect(result.usingNamespaces).toEqual(['std', 'std::ranges']);
    });

    it('skips anonymous namespaces but stays brace-balanced', () => {
        const src = `namespace {
  void hidden();
}
namespace other {
  void here();
}
`;
        const result = walk(src, 4);
        expect(result.enclosingScopes).toEqual(['other']);
    });

    it('does not push a scope for forward declarations', () => {
        const src = `class Foo;
struct Bar;
int main() {}
`;
        const result = walk(src, 2);
        expect(result.enclosingScopes).toEqual([]);
    });

    it('does not push a scope for namespace aliases', () => {
        const src = `namespace ns = ::std::detail;
int main() {}
`;
        const result = walk(src, 1);
        expect(result.enclosingScopes).toEqual([]);
    });

    it('pushes a class scope for inline member definitions', () => {
        const src = `class Foo {
  void bar() {
    here();
  }
};
`;
        const result = walk(src, 2);
        expect(result.enclosingScopes).toEqual(['Foo']);
    });

    it('handles a class scope inside a namespace', () => {
        const src = `namespace ns {
  class Foo {
    void bar() {
      here();
    }
  };
}
`;
        const result = walk(src, 3);
        expect(result.enclosingScopes).toEqual(['ns', 'Foo']);
    });

    it('ignores braces inside string literals', () => {
        const src = `namespace ns {
  const char* s = "}";
  void here();
}
`;
        const result = walk(src, 2);
        expect(result.enclosingScopes).toEqual(['ns']);
    });

    it('ignores braces inside line comments', () => {
        const src = `namespace ns {
  // }
  void here();
}
`;
        const result = walk(src, 2);
        expect(result.enclosingScopes).toEqual(['ns']);
    });
});

// ---- detectMemberAccess --------------------------------------------

describe('detectMemberAccess', () => {
    function lineDoc(line: string): Pick<vscode.TextDocument, 'lineAt'> {
        return {
            lineAt: ((arg: number | vscode.Position) => {
                const n = typeof arg === 'number' ? arg : arg.line;
                return { text: n === 0 ? line : '' } as unknown as vscode.TextLine;
            }) as Pick<vscode.TextDocument, 'lineAt'>['lineAt']
        };
    }
    function pos(character: number, line = 0): vscode.Position {
        return { line, character } as unknown as vscode.Position;
    }

    it('returns undefined when nothing precedes the cursor', () => {
        expect(detectMemberAccess(lineDoc('data();'), pos(0))).toBeUndefined();
    });

    it('detects a `.` member access', () => {
        // `vec.data` — cursor at `data` (column 4).
        expect(detectMemberAccess(lineDoc('vec.data();'), pos(4))).toEqual({
            kind: 'dot',
            receiver: ''
        });
    });

    it('detects a `->` member access', () => {
        expect(detectMemberAccess(lineDoc('ptr->next;'), pos(5))).toEqual({
            kind: 'arrow',
            receiver: ''
        });
    });

    it('detects a `::` member access and recovers the receiver', () => {
        expect(detectMemberAccess(lineDoc('TStr::data();'), pos(6))).toEqual({
            kind: 'colon',
            receiver: 'TStr'
        });
    });

    it('recovers a multi-segment receiver across `::` separators', () => {
        expect(
            detectMemberAccess(lineDoc('std::vector::data();'), pos(13))
        ).toEqual({ kind: 'colon', receiver: 'std::vector' });
    });

    it('tolerates whitespace between the operator and the cursor word', () => {
        expect(detectMemberAccess(lineDoc('TStr ::  data();'), pos(9))).toEqual({
            kind: 'colon',
            receiver: 'TStr'
        });
    });

    it('returns undefined when the prior char is an unrelated operator', () => {
        // `x + foo` — the `+` is not a member access.
        expect(detectMemberAccess(lineDoc('x + foo();'), pos(4))).toBeUndefined();
    });

    it('returns undefined for a malformed start position', () => {
        expect(
            detectMemberAccess(
                lineDoc('any'),
                undefined as unknown as vscode.Position
            )
        ).toBeUndefined();
    });
});

// ---- buildFqnCandidates --------------------------------------------

describe('buildFqnCandidates', () => {
    it('returns just the bare word with no scopes', () => {
        expect(
            buildFqnCandidates('sort', { enclosingScopes: [], usingNamespaces: [] })
        ).toEqual(['sort']);
    });

    it('prepends a single enclosing scope before the bare word', () => {
        expect(
            buildFqnCandidates('sort', {
                enclosingScopes: ['std'],
                usingNamespaces: []
            })
        ).toEqual(['std::sort', 'sort']);
    });

    it('walks enclosing scopes innermost-first', () => {
        expect(
            buildFqnCandidates('sort', {
                enclosingScopes: ['std', 'detail'],
                usingNamespaces: []
            })
        ).toEqual(['std::detail::sort', 'std::sort', 'sort']);
    });

    it('appends `using namespace` aliases between enclosing scopes and the bare word', () => {
        expect(
            buildFqnCandidates('sort', {
                enclosingScopes: [],
                usingNamespaces: ['std', 'std::ranges']
            })
        ).toEqual(['std::sort', 'std::ranges::sort', 'sort']);
    });

    it('combines enclosing scopes with using directives', () => {
        expect(
            buildFqnCandidates('sort', {
                enclosingScopes: ['std', 'detail'],
                usingNamespaces: ['std::ranges']
            })
        ).toEqual([
            'std::detail::sort',
            'std::sort',
            'std::ranges::sort',
            'sort'
        ]);
    });

    it('deduplicates while preserving first-occurrence order', () => {
        expect(
            buildFqnCandidates('sort', {
                enclosingScopes: ['std'],
                usingNamespaces: ['std']
            })
        ).toEqual(['std::sort', 'sort']);
    });
});

// ---- createFallbackStrategy ----------------------------------------

interface ShimRange {
    __range: true;
    start?: vscode.Position;
}

interface ShimDocOpts {
    text: string;
    /** word that getWordRangeAtPosition returns; undefined → no range. */
    word: string | undefined;
    /**
     * Optional `range.start` for the shim. When set, the member-access
     * detector reads `lineAt(start.line).text` and inspects the
     * character(s) immediately preceding `start.character`. Tests that
     * exercise the `Type::method` / `obj.method` paths must provide this
     * so the detector sees a real position instead of bailing out.
     */
    rangeStart?: { line: number; character: number };
}

function makeDoc(opts: ShimDocOpts): vscode.TextDocument {
    const lines = opts.text.split('\n');
    const range: ShimRange = { __range: true };
    if (opts.rangeStart) {
        range.start = opts.rangeStart as unknown as vscode.Position;
    }
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
            _pos: vscode.Position,
            _re?: RegExp
        ): vscode.Range | undefined => {
            void _pos;
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
    signal?: AbortSignal
): ResolveContext {
    const position = { line, character: 0 } as unknown as vscode.Position;
    return {
        document: doc,
        position,
        signal: signal ?? new AbortController().signal
    };
}

function makeIndex(
    exact: (fqn: string) => SymbolHit | undefined,
    unqualified: (name: string, parents: string[]) => SymbolHit[]
): Pick<IndexDB, 'lookupByUnqualified' | 'lookupExact'> {
    return {
        lookupExact: vi.fn((fqn: string) => exact(fqn)),
        lookupByUnqualified: vi.fn((name: string, parents: string[]) =>
            unqualified(name, parents)
        )
    } as unknown as Pick<IndexDB, 'lookupByUnqualified' | 'lookupExact'>;
}

function hit(qualifiedName: string): SymbolHit {
    return {
        id: 1,
        docsetId: 1,
        docsetName: 'cppreference',
        qualifiedName,
        unqualified: qualifiedName.split('::').pop() ?? qualifiedName,
        parent:
            qualifiedName.includes('::')
                ? qualifiedName.slice(0, qualifiedName.lastIndexOf('::'))
                : null,
        kind: 'function',
        filePath: 'en/cpp/algorithm/sort.html',
        anchor: null,
        arglist: null
    };
}

describe('createFallbackStrategy', () => {
    it('returns undefined when there is no word range under the cursor', async () => {
        const doc = makeDoc({ text: '   \n', word: undefined });
        const index = makeIndex(
            () => undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
        expect(index.lookupExact).not.toHaveBeenCalled();
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('returns undefined for C++ keywords with no Keyword/Language row in the index', async () => {
        // The fallback consults the index for a Keyword- or Language-kind
        // entry before giving up on a keyword token (some keywords have
        // dedicated cppreference pages — `template`, `requires`, `while`,
        // `static`, …). When the index has no matching row, the resolver
        // returns undefined so the chain doesn't surface a phantom hit.
        const doc = makeDoc({ text: 'return 0;\n', word: 'return' });
        const index = makeIndex(
            () => undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
        // The Keyword/Language rescue lookup IS attempted exactly once.
        const exact = index.lookupExact as unknown as ReturnType<typeof vi.fn>;
        expect(exact.mock.calls.map((c) => c[0])).toEqual(['return']);
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('resolves a C++ keyword when the index carries a Keyword-kind page', async () => {
        const doc = makeDoc({ text: 'while (x);\n', word: 'while' });
        const index = makeIndex(
            (fqn) =>
                fqn === 'while'
                    ? { ...hit('while'), kind: 'Keyword' }
                    : undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toEqual({
            fqn: 'while',
            source: 'fallback'
        });
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('resolves a C++ keyword when the index carries a Language-kind page', async () => {
        // cppreference often ships a `cpp/language/<kw>.html` page (kind=
        // Language) alongside `cpp/keyword/<kw>.html` (kind=Keyword); the
        // Language page is usually the tutorial-style explanation users
        // actually want, and lookupExact's tie-break may pick either one.
        // Both kinds must satisfy the rescue check.
        const doc = makeDoc({ text: 'if (x);\n', word: 'if' });
        const index = makeIndex(
            (fqn) =>
                fqn === 'if'
                    ? { ...hit('if'), kind: 'Language' }
                    : undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toEqual({
            fqn: 'if',
            source: 'fallback'
        });
    });

    it('resolves the first lookupExact hit and skips the unqualified lookup', async () => {
        const text = `namespace std {
  namespace detail {
    sort();
  }
}
`;
        const doc = makeDoc({ text, word: 'sort' });
        const index = makeIndex(
            (fqn) => (fqn === 'std::sort' ? hit('std::sort') : undefined),
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const result = await strategy(makeContext(doc, 2));
        expect(result).toEqual({ fqn: 'std::sort', source: 'fallback' });

        // Order of attempts: innermost first → std::detail::sort, then std::sort.
        const exact = index.lookupExact as unknown as ReturnType<typeof vi.fn>;
        expect(exact.mock.calls.map((c) => c[0])).toEqual([
            'std::detail::sort',
            'std::sort'
        ]);
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('falls back to lookupByUnqualified when no exact candidate hits', async () => {
        const text = `namespace ns {
  here();
}
`;
        const doc = makeDoc({ text, word: 'here' });
        const index = makeIndex(
            () => undefined,
            (name, parents) => {
                expect(name).toBe('here');
                // The strategy passes enclosing scopes ∪ using namespaces
                // straight through to the index lookup.
                expect(parents).toEqual(['ns']);
                return [hit('std::here'), hit('other::here')];
            }
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const result = await strategy(makeContext(doc, 1));
        expect(result).toEqual({ fqn: 'std::here', source: 'fallback' });
        expect(index.lookupByUnqualified).toHaveBeenCalledTimes(1);
    });

    it('returns undefined when both exact and unqualified lookups miss', async () => {
        const doc = makeDoc({ text: 'sort();\n', word: 'sort' });
        const index = makeIndex(
            () => undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
    });

    it('throws AbortError when the signal is already aborted on entry', async () => {
        const doc = makeDoc({ text: 'sort();\n', word: 'sort' });
        const index = makeIndex(
            () => undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const controller = new AbortController();
        controller.abort();
        await expect(
            strategy(makeContext(doc, 0, controller.signal))
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('treats abort during the lookup loop the same as abort on entry', async () => {
        // The strategy calls lookupExact synchronously; the only realistic
        // place an abort can fire mid-flight is between checks. Pin down
        // the contract: aborted before any lookup result is observable
        // surfaces as either AbortError or undefined (consistent with the
        // M4.1 strategy's choice).
        const doc = makeDoc({ text: 'sort();\n', word: 'sort' });
        const index = makeIndex(
            () => undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });

        const controller = new AbortController();
        const promise = strategy(makeContext(doc, 0, controller.signal));
        controller.abort();
        let threw: unknown;
        let resolved: unknown;
        try {
            resolved = await promise;
        } catch (e) {
            threw = e;
        }
        if (threw === undefined) {
            expect(resolved).toBeUndefined();
        } else {
            expect((threw as Error).name).toBe('AbortError');
        }
    });

    it('passes enclosing scopes ∪ using directives to lookupByUnqualified', async () => {
        const text = `using namespace std;
using namespace std::ranges;
namespace ns {
  here();
}
`;
        const doc = makeDoc({ text, word: 'here' });
        let received: { name: string; parents: string[] } | undefined;
        const index = makeIndex(
            () => undefined,
            (name, parents) => {
                received = { name, parents };
                return [hit('ns::here')];
            }
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const result = await strategy(makeContext(doc, 3));
        expect(result).toEqual({ fqn: 'ns::here', source: 'fallback' });
        expect(received).toEqual({
            name: 'here',
            parents: ['ns', 'std', 'std::ranges']
        });
    });

    // Member-access guard — `obj.method`, `ptr->method`, and
    // `Receiver::method`. The fallback used to fall through to a top-
    // level unqualified lookup, which matched `data` against `std::data`
    // even when the cursor was on a member call (`TStr::data()`,
    // `vec.data()`). Each scenario below pins down the corrected
    // behavior.

    it('returns undefined for `obj.method` member access (no top-level fallback)', async () => {
        // `vec.data()` cursor on `data` (line 0, char 4). The fallback
        // must not match `std::data` from `lookupByUnqualified`.
        const doc = makeDoc({
            text: 'vec.data();',
            word: 'data',
            rangeStart: { line: 0, character: 4 }
        });
        const index = makeIndex(
            () => undefined,
            (name, _parents) => {
                if (name === 'data') return [hit('std::data')];
                return [];
            }
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('returns undefined for `ptr->method` member access', async () => {
        const doc = makeDoc({
            text: 'ptr->next;',
            word: 'next',
            rangeStart: { line: 0, character: 5 }
        });
        const index = makeIndex(
            () => undefined,
            () => [hit('std::next')]
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('returns undefined for `Receiver::method` when the receiver is unknown', async () => {
        // `TStr::data()` where TStr is a user typedef not in the index.
        // Pre-fix this matched `std::data` via the unqualified fallback.
        const doc = makeDoc({
            text: 'TStr::data();',
            word: 'data',
            rangeStart: { line: 0, character: 6 }
        });
        const index = makeIndex(
            (fqn) => (fqn === 'TStr::data' ? undefined : undefined),
            (name) => (name === 'data' ? [hit('std::data')] : [])
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        expect(await strategy(makeContext(doc, 0))).toBeUndefined();
        // The colon-access path tries `TStr::data` (exact) but must NOT
        // fall back to the bare-word unqualified lookup.
        const exact = index.lookupExact as unknown as ReturnType<typeof vi.fn>;
        expect(exact.mock.calls.map((c) => c[0])).toContain('TStr::data');
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('resolves `Receiver::method` when the receiver IS in the index', async () => {
        // `std::vector::data` should still resolve via the colon-access
        // path — the guard only suppresses the unqualified-fallback, not
        // the exact-lookup chain.
        const doc = makeDoc({
            text: 'std::vector::data();',
            word: 'data',
            rangeStart: { line: 0, character: 13 }
        });
        const index = makeIndex(
            (fqn) =>
                fqn === 'std::vector::data' ? hit('std::vector::data') : undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const result = await strategy(makeContext(doc, 0));
        expect(result).toEqual({
            fqn: 'std::vector::data',
            source: 'fallback'
        });
        expect(index.lookupByUnqualified).not.toHaveBeenCalled();
    });

    it('combines enclosing scope with the receiver for `::`-access candidates', async () => {
        // Inside `namespace std { vector::data() }`, the receiver is
        // `vector` and the enclosing scope is `std`; the candidate
        // `std::vector::data` should be attempted before bare `vector::data`.
        const text = `namespace std {
  vector::data();
}
`;
        const doc = makeDoc({
            text,
            word: 'data',
            rangeStart: { line: 1, character: 10 }
        });
        const index = makeIndex(
            (fqn) =>
                fqn === 'std::vector::data' ? hit('std::vector::data') : undefined,
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index
        });
        const result = await strategy(makeContext(doc, 1));
        expect(result?.fqn).toBe('std::vector::data');
    });

    it('honors a custom wordPattern', async () => {
        // A pattern that returns no range exercises the custom-pattern path
        // without depending on getWordRangeAtPosition's internal regex.
        const customPattern = /[A-Z][A-Za-z]*/;
        let receivedPattern: RegExp | undefined;
        const lines = ['Sort();'];
        const range: ShimRange = { __range: true };
        const doc = {
            uri: { toString: (): string => 'file:///tmp/x.cpp' },
            version: 1,
            languageId: 'cpp',
            lineCount: lines.length,
            lineAt: (n: number): vscode.TextLine =>
                ({ text: lines[n] ?? '' }) as unknown as vscode.TextLine,
            getText: () => 'Sort',
            getWordRangeAtPosition: (
                _p: vscode.Position,
                re?: RegExp
            ): vscode.Range | undefined => {
                receivedPattern = re;
                return range as unknown as vscode.Range;
            }
        } as unknown as vscode.TextDocument;
        const index = makeIndex(
            (fqn) => (fqn === 'Sort' ? hit('Sort') : undefined),
            () => []
        );
        const strategy = createFallbackStrategy({
            vscode: {} as typeof vscode,
            index,
            wordPattern: customPattern
        });
        const result = await strategy(makeContext(doc, 0));
        expect(receivedPattern).toBe(customPattern);
        expect(result).toEqual({ fqn: 'Sort', source: 'fallback' });
    });
});
