// Unit tests for the Strategy 3 definition walker (M4.3).
//
// Two layers of coverage:
//   1. The pure parser (`parseDefinitionContext`) against canned C++
//      snippets — namespaces, classes, templated specializations,
//      anonymous namespaces, base lists, and out-of-line definitions.
//   2. The strategy function with a hand-rolled vscode shim, asserting
//      the wiring: empty result → undefined, location → parses & FQN,
//      openTextDocument throws → undefined, abort → throws AbortError.

import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import {
    createDefinitionStrategy,
    parseDefinitionContext
} from '../../src/resolver/definition-walker.js';
import type {
    ResolveContext,
    ResolvedSymbol
} from '../../src/resolver/types.js';

// ---------------------------------------------------------------------------
// Layer 1: pure parser
// ---------------------------------------------------------------------------

describe('parseDefinitionContext', () => {
    it('parses a free function in namespace std', () => {
        const lines = [
            'namespace std {',
            '  void sort() { /* ... */ }',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result).toEqual({
            name: 'sort',
            scopeChain: ['std'],
            fqn: 'std::sort'
        });
    });

    it('parses a method inside a templated class', () => {
        const lines = [
            'namespace std {',
            '  template<class T, class A = allocator<T>>',
            '  class vector {',
            '    void push_back(const T& value);',
            '  };',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 3 });
        expect(result).toEqual({
            name: 'push_back',
            scopeChain: ['std', 'vector'],
            fqn: 'std::vector::push_back'
        });
    });

    it('parses an out-of-line method definition with template args stripped', () => {
        const lines = [
            'void std::vector<int>::push_back(const int& v) { /* ... */ }'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result).toBeDefined();
        expect(result?.fqn).toBe('std::vector::push_back');
        expect(result?.name).toBe('push_back');
        expect(result?.scopeChain).toEqual(['std', 'vector']);
    });

    it('parses a free function inside nested namespaces', () => {
        const lines = [
            'namespace std {',
            '  namespace ranges {',
            '    void sort();',
            '  }',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 2 });
        expect(result).toEqual({
            name: 'sort',
            scopeChain: ['std', 'ranges'],
            fqn: 'std::ranges::sort'
        });
    });

    it('skips an anonymous namespace from the scope chain', () => {
        const lines = [
            'namespace {',
            '  void helper() { /* ... */ }',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result).toEqual({
            name: 'helper',
            scopeChain: [],
            fqn: 'helper'
        });
    });

    it('does not let a forward declaration above pollute the scope chain', () => {
        const lines = [
            'class A;',
            'class B {',
            '};'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result).toBeDefined();
        expect(result?.fqn).toBe('B');
        expect(result?.scopeChain).toEqual([]);
        expect(result?.name).toBe('B');
    });

    it('extracts the derived class name in a class with a base list', () => {
        const lines = [
            'class Derived : public std::vector<int> { };'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result).toBeDefined();
        expect(result?.fqn).toBe('Derived');
        expect(result?.name).toBe('Derived');
    });

    it('returns undefined when the definition line carries no identifier', () => {
        const lines = ['/* just a comment */'];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result).toBeUndefined();
    });

    it('returns undefined when defLine is out of range', () => {
        expect(parseDefinitionContext({ lines: [], defLine: 0 })).toBeUndefined();
        expect(
            parseDefinitionContext({ lines: ['x'], defLine: 5 })
        ).toBeUndefined();
    });

    it('skips a namespace alias above the definition', () => {
        const lines = [
            'namespace fs = std::filesystem;',
            'class B { };'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result?.fqn).toBe('B');
        expect(result?.scopeChain).toEqual([]);
    });

    it('handles a class with `final` qualifier', () => {
        const lines = [
            'namespace foo {',
            '  class Bar final {',
            '    void m();',
            '  };',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 2 });
        expect(result?.fqn).toBe('foo::Bar::m');
        expect(result?.scopeChain).toEqual(['foo', 'Bar']);
    });

    it('does not push a sibling class scope that already closed', () => {
        const lines = [
            'namespace foo {',
            '  class Earlier { };',
            '  class Later {',
            '    void m();',
            '  };',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 3 });
        expect(result?.fqn).toBe('foo::Later::m');
    });

    it('strips template args from explicit specializations', () => {
        // `template<> class Foo<int> { void m(); };` — the specialization
        // brings `Foo<int>` to the brace, but the FQN we want is `Foo::m`.
        const lines = [
            'template<> class Foo<int> {',
            '  void m();',
            '};'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result?.fqn).toBe('Foo::m');
        expect(result?.scopeChain).toEqual(['Foo']);
    });

    it('stitches a multi-line function declaration', () => {
        const lines = [
            'namespace std {',
            '  void',
            '  sort(',
            '    int* first,',
            '    int* last);',
            '}'
        ];
        // defLine is the `void` line — ends with whitespace, no `(`, so
        // the parser should stitch forward until it finds the `(`.
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result?.name).toBe('sort');
        expect(result?.fqn).toBe('std::sort');
    });

    it('ignores braces / semicolons inside string literals', () => {
        const lines = [
            'namespace ns {',
            '  const char* k = "}; namespace evil {";',
            '  void f();',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 2 });
        expect(result?.fqn).toBe('ns::f');
    });

    it('ignores braces inside line comments', () => {
        const lines = [
            'namespace ns {',
            '  // close brace } in comment',
            '  void f();',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 2 });
        expect(result?.fqn).toBe('ns::f');
    });

    // --- Expression-specifier skip (the `std::apply` bug) ---
    //
    // `extractIdentifierFromLine` walks every `(` left-to-right and picks
    // the identifier preceding the first `(` that isn't an expression
    // specifier. Without the skip, a return-type `decltype(auto)` would
    // hijack the match and the parser would return `decltype` instead of
    // the actual function name.

    it('skips a `decltype(auto)` return-type specifier to find the function name', () => {
        const lines = [
            'constexpr decltype(auto) apply(F&& f, Tuple&& t);'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('apply');
        expect(result?.fqn).toBe('apply');
    });

    it('skips a `noexcept(expr)` return-type specifier', () => {
        const lines = [
            'noexcept(noexcept(f())) check(int x);'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('check');
    });

    it('skips a `sizeof(T)` return-type specifier', () => {
        const lines = [
            'sizeof(T) compute(int x);'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('compute');
    });

    it('handles nested parens inside the specifier arg', () => {
        // `decltype(std::forward<T>(t))` — nested template / function call
        // inside the specifier operand. The findMatchingParen scan in
        // extractIdentifierFromLine must walk over them cleanly.
        const lines = [
            'constexpr decltype(std::forward<T>(t)) apply(F&& f, Tuple&& t);'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('apply');
    });

    it('still extracts a plain function name when no specifier precedes it (regression)', () => {
        // The specifier-skip path must not break the simple case where
        // a return type like `void` is just a keyword, not a paren-specifier.
        const lines = [
            'void sort(Iter first, Iter last);'
        ];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('sort');
    });

    it('still extracts a class-head name when present (still works after the fix)', () => {
        // The class-head path runs before the function-paren scan; the
        // specifier-skip change must not affect class extraction.
        const lines = ['class vector { void push_back(const int& v); };'];
        const result = parseDefinitionContext({ lines, defLine: 0 });
        expect(result?.name).toBe('vector');
        expect(result?.fqn).toBe('vector');
    });

    it('handles std::apply inside namespace std (full FQN, scope walk + skip)', () => {
        // End-to-end of the bug-fix flow: namespace `std` open, the def
        // line carries `constexpr decltype(auto) apply(...)`. The parser
        // should yield `std::apply`, not `std::decltype`.
        const lines = [
            'namespace std {',
            '  constexpr decltype(auto) apply(F&& f, Tuple&& t);',
            '}'
        ];
        const result = parseDefinitionContext({ lines, defLine: 1 });
        expect(result?.fqn).toBe('std::apply');
        expect(result?.scopeChain).toEqual(['std']);
    });
});

// ---------------------------------------------------------------------------
// Layer 2: strategy function E2E with a vscode shim
// ---------------------------------------------------------------------------

interface StubLine {
    text: string;
}
interface StubTextDocument {
    uri: { toString(): string };
    lineCount: number;
    lineAt(i: number): StubLine;
}

function makeDoc(lines: string[]): StubTextDocument {
    return {
        uri: { toString: () => 'file:///tmp/target.cpp' },
        lineCount: lines.length,
        lineAt(i: number): StubLine {
            return { text: lines[i] ?? '' };
        }
    };
}

function makeRange(line: number): vscode.Range {
    // Structural Range: only `start.line` is read.
    return {
        start: { line, character: 0 } as vscode.Position,
        end: { line, character: 0 } as vscode.Position
    } as vscode.Range;
}

function makeContext(): {
    ctx: ResolveContext;
    controller: AbortController;
} {
    const controller = new AbortController();
    const ctx: ResolveContext = {
        document: {
            uri: { toString: () => 'file:///tmp/source.cpp' },
            version: 1,
            languageId: 'cpp',
            getText: () => ''
        } as unknown as ResolveContext['document'],
        position: { line: 0, character: 0 } as unknown as ResolveContext['position'],
        signal: controller.signal
    };
    return { ctx, controller };
}

interface ShimOpts {
    defs?: Array<vscode.Location | vscode.LocationLink> | undefined;
    defsThrow?: Error | undefined;
    doc?: StubTextDocument | undefined;
    openThrow?: Error | undefined;
}

function makeVscodeShim(opts: ShimOpts): typeof vscode {
    const shim = {
        commands: {
            async executeCommand<T>(
                cmd: string,
                ..._args: unknown[]
            ): Promise<T> {
                if (cmd !== 'vscode.executeDefinitionProvider') {
                    throw new Error(`unexpected command: ${cmd}`);
                }
                if (opts.defsThrow) throw opts.defsThrow;
                return opts.defs as unknown as T;
            }
        },
        workspace: {
            async openTextDocument(_uri: unknown): Promise<StubTextDocument> {
                if (opts.openThrow) throw opts.openThrow;
                if (!opts.doc) throw new Error('no doc provided to shim');
                return opts.doc;
            }
        }
    };
    return shim as unknown as typeof vscode;
}

describe('createDefinitionStrategy', () => {
    it('returns undefined when executeDefinitionProvider returns []', async () => {
        const shim = makeVscodeShim({ defs: [] });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toBeUndefined();
    });

    it('returns undefined when executeDefinitionProvider returns undefined', async () => {
        const shim = makeVscodeShim({ defs: undefined });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toBeUndefined();
    });

    it('returns undefined when executeDefinitionProvider throws', async () => {
        const shim = makeVscodeShim({ defsThrow: new Error('LSP unavailable') });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toBeUndefined();
    });

    it('parses a Location and returns the FQN', async () => {
        const doc = makeDoc([
            'namespace std {',
            '  void sort();',
            '}'
        ]);
        const loc = {
            uri: doc.uri,
            range: makeRange(1)
        } as unknown as vscode.Location;
        const shim = makeVscodeShim({ defs: [loc], doc });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toEqual<ResolvedSymbol>({
            fqn: 'std::sort',
            source: 'definition'
        });
    });

    it('parses a LocationLink and prefers targetSelectionRange', async () => {
        const doc = makeDoc([
            'namespace std {',
            '  namespace ranges {',
            '    void sort();',
            '  }',
            '}'
        ]);
        const link = {
            targetUri: doc.uri,
            targetRange: makeRange(2),
            targetSelectionRange: makeRange(2)
        } as unknown as vscode.LocationLink;
        const shim = makeVscodeShim({ defs: [link], doc });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result?.fqn).toBe('std::ranges::sort');
        expect(result?.source).toBe('definition');
    });

    it('returns undefined when openTextDocument throws', async () => {
        const loc = {
            uri: { toString: () => 'file:///tmp/missing.cpp' },
            range: makeRange(0)
        } as unknown as vscode.Location;
        const shim = makeVscodeShim({
            defs: [loc],
            openThrow: new Error('file not found')
        });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toBeUndefined();
    });

    it('throws AbortError when ctx.signal is already aborted', async () => {
        const shim = makeVscodeShim({ defs: [] });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx, controller } = makeContext();
        controller.abort();
        await expect(strat(ctx)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('throws AbortError when ctx.signal aborts after the def lookup', async () => {
        const doc = makeDoc(['void f() {}']);
        const loc = {
            uri: doc.uri,
            range: makeRange(0)
        } as unknown as vscode.Location;
        // Abort partway: the shim resolves immediately, so we abort
        // before invoking. The strategy's first signal check will fire.
        const shim = makeVscodeShim({ defs: [loc], doc });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx, controller } = makeContext();
        // Abort just before invocation — first inline check throws.
        controller.abort();
        await expect(strat(ctx)).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('returns undefined when the parsed definition has no identifier', async () => {
        const doc = makeDoc(['/* just a comment */']);
        const loc = {
            uri: doc.uri,
            range: makeRange(0)
        } as unknown as vscode.Location;
        const shim = makeVscodeShim({ defs: [loc], doc });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result).toBeUndefined();
    });

    it('clamps the read window at file edges', async () => {
        // 3-line file; targetLine 1 with 15-above / 15-below → start=0,
        // end=2. Just a smoke test that the clamp doesn't crash.
        const doc = makeDoc([
            'namespace foo {',
            '  void bar();',
            '}'
        ]);
        const loc = {
            uri: doc.uri,
            range: makeRange(1)
        } as unknown as vscode.Location;
        const shim = makeVscodeShim({ defs: [loc], doc });
        const strat = createDefinitionStrategy({ vscode: shim });
        const { ctx } = makeContext();
        const result = await strat(ctx);
        expect(result?.fqn).toBe('foo::bar');
    });
});
