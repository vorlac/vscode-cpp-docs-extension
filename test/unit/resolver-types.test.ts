// Contract test for the resolver public-type surface.
//
// This test enforces — at compile time and at runtime — that the
// shapes locked in `src/resolver/types.ts` and `src/resolver/cpp.ts`
// stay stable while the five parallel sub-tasks (M4.1–M4.5) build
// against them. It does NOT exercise behavior; M4.1–M4.6 add their
// own behavioral tests.

import { describe, expect, it } from 'vitest';
import type {
    ComposeOptions,
    Resolver,
    ResolverStrategy,
    ResolverStrategyName
} from '../../src/resolver/cpp.js';
import { composeResolver } from '../../src/resolver/cpp.js';
import type {
    ResolveContext,
    ResolvedSymbol
} from '../../src/resolver/types.js';

// Minimal structural duck-types of the vscode primitives the resolver
// types reference. Real strategy implementations and the composer
// typecheck against `vscode.TextDocument` / `vscode.Position`; tests
// only need the structural shape.
interface StubPosition {
    line: number;
    character: number;
}
interface StubUri {
    toString(): string;
}
interface StubTextDocument {
    uri: StubUri;
    version: number;
    languageId: string;
    getText(): string;
}

// Type-only assertion: a `ResolveContext` literal built from our stubs
// satisfies the declared interface. Calling this with our literal
// would fail compilation if the interface drifted.
function acceptsContext(_c: ResolveContext): void {
    // intentionally empty — type assertion only
}

describe('resolver type contract', () => {
    it('ResolveContext accepts a structurally-valid literal', () => {
        const document: StubTextDocument = {
            uri: { toString: () => 'file:///tmp/x.cpp' },
            version: 1,
            languageId: 'cpp',
            getText: () => ''
        };
        const position: StubPosition = { line: 0, character: 0 };
        const controller = new AbortController();

        // Cast through `unknown` because the stub is a structural subset
        // of `vscode.TextDocument` / `vscode.Position`; the real types
        // carry extra members we don't model in tests. The cast is the
        // contract assertion — if the *required* shape changes, this stops
        // compiling.
        const ctx: ResolveContext = {
            document: document as unknown as ResolveContext['document'],
            position: position as unknown as ResolveContext['position'],
            signal: controller.signal
        };

        acceptsContext(ctx);
        expect(ctx.signal.aborted).toBe(false);
        controller.abort();
        expect(ctx.signal.aborted).toBe(true);
    });

    it('ResolvedSymbol round-trips through JSON with all optional fields', () => {
        const original: ResolvedSymbol = {
            fqn: 'std::vector::push_back',
            source: 'clangd',
            usr: 'c:@ST>2#T#T@vector@F@push_back#&&t0.0#',
            anchor: 'overload-1'
        };
        const roundTripped = JSON.parse(JSON.stringify(original)) as ResolvedSymbol;
        expect(roundTripped).toEqual(original);
    });

    it('ResolvedSymbol round-trips with only the required field', () => {
        const original: ResolvedSymbol = { fqn: 'std::sort' };
        const roundTripped = JSON.parse(JSON.stringify(original)) as ResolvedSymbol;
        expect(roundTripped).toEqual(original);
        expect(roundTripped.source).toBeUndefined();
        expect(roundTripped.usr).toBeUndefined();
        expect(roundTripped.anchor).toBeUndefined();
    });

    it('ResolverStrategyName is exactly the five expected literals', () => {
        // Exhaustive switch — TS will fail to compile if a case is missing
        // or extra. The runtime assertions back-stop the compile-time check.
        function classify(name: ResolverStrategyName): number {
            switch (name) {
                case 'keyword':
                    return 0;
                case 'clangd':
                    return 1;
                case 'hover':
                    return 2;
                case 'definition':
                    return 3;
                case 'fallback':
                    return 4;
                default: {
                    const _exhaustive: never = name;
                    return _exhaustive;
                }
            }
        }
        expect(classify('keyword')).toBe(0);
        expect(classify('clangd')).toBe(1);
        expect(classify('hover')).toBe(2);
        expect(classify('definition')).toBe(3);
        expect(classify('fallback')).toBe(4);
    });

    it('ResolverStrategy accepts an async function returning ResolvedSymbol | undefined', () => {
        // Type-only: assigning to a typed variable enforces the signature.
        const strategy: ResolverStrategy = async (ctx) => {
            void ctx;
            return undefined;
        };
        expect(typeof strategy).toBe('function');
    });

    it('composeResolver accepts the documented argument shape and is callable', () => {
        // M4.6 replaced the throwing stub with the real composer. We
        // assert here only that the surface is intact — the four-name
        // input shape is accepted, options compile, and the returned
        // value satisfies `Resolver`. Behavior is covered by
        // `resolver-compose.test.ts`.
        const strategy: ResolverStrategy = async () => undefined;
        const strategies: ReadonlyArray<{
            name: ResolverStrategyName;
            strategy: ResolverStrategy;
        }> = [
                { name: 'clangd', strategy },
                { name: 'hover', strategy },
                { name: 'definition', strategy },
                { name: 'fallback', strategy }
            ];
        const options: ComposeOptions = { timeoutMs: 250, now: () => 0 };

        const resolver = composeResolver(strategies, options);
        expect(typeof resolver.resolve).toBe('function');
        expect(resolver.strategyOrder).toEqual([
            'clangd',
            'hover',
            'definition',
            'fallback'
        ]);
    });

    it('Resolver shape is structurally honored by a hand-rolled stub', () => {
        // A tiny stub that satisfies `Resolver` — proves the interface is
        // implementable as documented. Strategy sub-tasks build similar
        // stubs in their own tests.
        const stub: Resolver = {
            strategyOrder: ['clangd', 'hover', 'definition', 'fallback'] as const,
            async resolve() {
                return undefined;
            }
        };
        expect(stub.strategyOrder).toEqual([
            'clangd',
            'hover',
            'definition',
            'fallback'
        ]);
        expect(stub.strategyOrder.length).toBe(4);
    });
});
