// Public Resolver composition surface.
//
// M4.6 lands the real implementation. The composer iterates strategies
// in the order supplied at construction time, races each against a
// per-strategy timeout (default 250 ms via `options.timeoutMs`,
// matching `cppDocs.resolver.timeoutMs`), and stops at the first
// non-undefined result. A fresh `AbortController` is created per
// strategy and aborted on timeout so cancellable strategies (clangd's
// LSP request, hover-provider race) can wind down cleanly.
//
// Failure modes folded into "miss" (chain advances):
//   - timeout (signal aborted, strategy may settle later — we ignore)
//   - strategy throws (any error, including AbortError)
//   - strategy returns undefined
//
// Logging deferred to M6 polish; for now the composer is silent on
// every miss path so debug noise stays predictable.
//
// The cache layer (`./cache.ts`, M4.5) wraps a composed resolver with
// `wrapWithCache(composed, cache)`. `buildProductionResolver` does that
// wiring for `extension.ts`.
//
// Per docs/03-symbol-resolution.md (pipeline + per-step budget) and
// docs/02-architecture.md § "Resolver wiring".
import type * as vscode from 'vscode';
import type { SymbolHit } from '../docset/types.js';
import { createClangdStrategy } from './clangd-bridge.js';
import { createDefinitionStrategy } from './definition-walker.js';
import { createFallbackStrategy } from './fallback.js';
import { createHoverStrategy } from './hover-parser.js';
import { createKeywordStrategy } from './keyword.js';
import { createResolverCache, wrapWithCache } from './cache.js';
import { wrapWithDirectiveAwareness } from './directive-aware.js';
import { wrapWithIncludeAwareness } from './include-aware.js';
import type {
    ResolveContext,
    Resolver,
    ResolvedSymbol,
    ResolverStrategy,
    ResolverStrategyName
} from './types.js';

export type {
    ResolveContext,
    Resolver,
    ResolvedSymbol,
    ResolverStrategy,
    ResolverStrategyName
};

const DEFAULT_TIMEOUT_MS = 250;

/**
 * Options for `composeResolver`.
 */
export interface ComposeOptions {
    /**
     * Per-strategy timeout (ms). Each strategy is `Promise.race`'d
     * against this; on timeout the strategy is abandoned and the chain
     * proceeds to the next one. Default 250, matching
     * `cppDocs.resolver.timeoutMs`.
     */
    timeoutMs?: number;
    /** Optional clock injection for tests. Defaults to `Date.now`. */
    now?: () => number;
}

/**
 * A single strategy entry as passed to `composeResolver`. The `name`
 * is used to fill `result.source` when a strategy doesn't set it
 * itself, and is exposed via `Resolver.strategyOrder` for tests and
 * debug logging.
 */
export interface ResolverStrategyEntry {
    name: ResolverStrategyName;
    strategy: ResolverStrategy;
}

/**
 * Compose a list of strategies into a single resolver. Stops at the
 * first non-undefined result. Each strategy is wrapped in
 * `Promise.race` against `timeoutMs`; on timeout the strategy is
 * abandoned (`AbortController.abort()`) and the chain proceeds.
 *
 * The strategy implementations live in sibling files under
 * `src/resolver/`:
 *   - `clangd-bridge.ts`     (M4.1)
 *   - `hover-parser.ts`      (M4.2)
 *   - `definition-walker.ts` (M4.3)
 *   - `fallback.ts`          (M4.4)
 *
 * Caching is layered on top by `cache.ts` (M4.5) — wrap the composed
 * resolver via `wrapWithCache(resolver, cache)`. `buildProductionResolver`
 * does that wiring for the production case.
 */
export function composeResolver(
    strategies: ReadonlyArray<ResolverStrategyEntry>,
    options?: ComposeOptions
): Resolver {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const order: readonly ResolverStrategyName[] = strategies.map((s) => s.name);

    return {
        strategyOrder: order,
        async resolve(
            document: vscode.TextDocument,
            position: vscode.Position
        ): Promise<ResolvedSymbol | undefined> {
            for (const entry of strategies) {
                const controller = new AbortController();
                const ctx: ResolveContext = {
                    document,
                    position,
                    signal: controller.signal
                };

                const result = await raceStrategy(entry.strategy, ctx, controller, timeoutMs);
                if (result === undefined) continue;
                // Composer fills `source` only when the strategy left it unset.
                if (result.source === undefined) {
                    return { ...result, source: entry.name };
                }
                return result;
            }
            return undefined;
        }
    };
}

/**
 * Race one strategy's promise against a `setTimeout`-backed timeout.
 * On timeout we abort the controller (so cooperatively-cancellable
 * strategies can wind down) and treat the slot as a miss. We then
 * resolve with `undefined`. The strategy's eventual settlement —
 * whether resolving with a hit or rejecting — is ignored because the
 * race already declared a winner.
 *
 * Errors thrown by the strategy (including `AbortError`) collapse to a
 * miss without propagating. This matches docs/03-symbol-resolution.md:
 * a strategy must never break the chain.
 */
function raceStrategy(
    strategy: ResolverStrategy,
    ctx: ResolveContext,
    controller: AbortController,
    timeoutMs: number
): Promise<ResolvedSymbol | undefined> {
    return new Promise<ResolvedSymbol | undefined>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            // Abort the strategy's signal — cooperatively-cancellable
            // strategies (clangd, hover) check `ctx.signal` and bail.
            // Strategies that don't honor the signal still get abandoned
            // because the race has already declared a winner.
            try {
                controller.abort();
            } catch {
                // AbortController.abort() can throw on very old runtimes.
                // Swallow — the timeout is the meaningful side effect.
            }
            resolve(undefined);
        }, Math.max(0, timeoutMs));

        Promise.resolve()
            .then(() => strategy(ctx))
            .then(
                (value) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(value);
                },
                (_err: unknown) => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    // Both AbortError and unexpected throws collapse to "miss".
                    // M6 will add structured logging here for the latter.
                    resolve(undefined);
                }
            );
    });
}

/**
 * Production wiring: assemble the full strategy chain and wrap it with
 * the LRU cache. Called by `extension.ts` at activation time.
 *
 * The clangd strategy is conditionally present per
 * `cppDocs.resolver.preferLanguageServer`; the other three always run.
 * Disabling clangd jumps straight to hover-text parsing (the durable
 * path per docs/06-gotchas.md item 20: clangd-23 removed `symbolInfo`).
 */
/**
 * Minimal index surface required by `buildProductionResolver`. Uses a
 * structural interface so both `IndexDB` (in tests) and `DocsetManager`
 * (in production) satisfy it without importing either concrete type.
 */
export interface ResolverIndex {
    lookupExact(qualifiedName: string, docsetId?: number): SymbolHit | undefined;
    lookupByUnqualified(name: string, parents: string[], docsetId?: number): SymbolHit[];
    lookupHeader(qualifiedName: string): SymbolHit | undefined;
}

export interface ResolverFactoryDeps {
    vscode: typeof vscode;
    /** Aggregate index; consumed by keyword, fallback, include-aware, and directive-aware strategies. */
    index: ResolverIndex;
    /**
     * Read-on-demand config accessor. Re-evaluated for every resolver
     * construction; runtime changes to `timeoutMs` /
     * `preferLanguageServer` require a rebuild (currently triggered only
     * at activation — config changes are M6's problem to plumb).
     */
    config: () => { timeoutMs: number; preferLanguageServer: boolean };
}

/**
 * Build the production resolver: keyword → clangd (optional) → hover
 * → definition → fallback, wrapped in the M4.5 LRU cache and the
 * include-context guard.
 *
 * Why keyword runs first: clangd's hover surfaces the surrounding
 * declaration's content (variable type, alias RHS, etc.) when the
 * cursor sits on a keyword that introduces a declaration. The hover
 * strategy parses that and returns it as the resolved symbol — but
 * the user pointing at `static` / `inline` / `using` clearly wants
 * the keyword's docs page, not whatever type or expression happens to
 * appear in the surrounding declaration. The keyword strategy
 * short-circuits the chain for those cases.
 */
export function buildProductionResolver(deps: ResolverFactoryDeps): Resolver {
    const cfg = deps.config();
    const strategies: ResolverStrategyEntry[] = [];

    strategies.push({
        name: 'keyword',
        strategy: createKeywordStrategy({
            index: deps.index
        })
    });

    if (cfg.preferLanguageServer) {
        strategies.push({
            name: 'clangd',
            strategy: createClangdStrategy({
                vscode: deps.vscode
            })
        });
    }

    strategies.push({
        name: 'hover',
        strategy: createHoverStrategy({
            vscode: deps.vscode
        })
    });

    strategies.push({
        name: 'definition',
        strategy: createDefinitionStrategy({
            vscode: deps.vscode
        })
    });

    strategies.push({
        name: 'fallback',
        strategy: createFallbackStrategy({
            vscode: deps.vscode,
            index: deps.index,
        })
    });

    const composed = composeResolver(strategies, {
        timeoutMs: cfg.timeoutMs
    });

    const cache = createResolverCache();
    // Wrapper order (outermost → innermost):
    //   directive-awareness → include-awareness → cache → composed chain
    //
    // Directive-awareness sits outermost so it can intercept cursor-on-`if`
    // inside `#if` before the keyword strategy (which would wrongly return the
    // C++ keyword page) even gets a chance. Include-awareness is next so
    // `#include` lines still fall through cleanly from the directive wrapper.
    // The cache wraps only the composed chain so neither guard can return a
    // stale cached hit from a different line context.
    return wrapWithDirectiveAwareness(
        wrapWithIncludeAwareness(wrapWithCache(composed, cache), deps.index),
        deps.index
    );
}
