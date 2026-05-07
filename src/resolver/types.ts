// Pure type module for the C++ symbol resolver.
//
// This file defines the public surface that the four parallel strategy
// implementations (M4.1 clangd-bridge, M4.2 hover-parser, M4.3
// definition-walker, M4.4 fallback) and the cache layer (M4.5) build
// against. The composer (M4.6) wires them together. Locking the shape
// here is what makes those parallel sub-tasks safe to merge.
//
// Per docs/03-symbol-resolution.md and docs/02-architecture.md.
//
// `vscode` is imported with `import type` only — this module pulls no
// runtime dependency on vscode, so strategy unit tests can import the
// types without a vscode shim.
import type * as vscode from 'vscode';

/**
 * Inputs to a single resolver-strategy invocation.
 *
 * The `signal` is wired from the per-strategy timeout race performed by
 * `composeResolver` (default `cppDocs.resolver.timeoutMs`, 250 ms). A
 * strategy that performs cancellable work (e.g. an LSP request) should
 * forward this signal and treat abort as a miss; strategies that can't
 * cancel mid-flight may ignore it — the composer will abandon the
 * promise on timeout regardless.
 */
export interface ResolveContext {
    document: vscode.TextDocument;
    position: vscode.Position;
    /** AbortSignal for the per-strategy timeout race. */
    signal: AbortSignal;
}

/**
 * The strategies that participate in the resolver chain, in priority
 * order. The composer fixes this order at construction time;
 * `Resolver.strategyOrder` exposes it for tests and debug logging.
 *
 * - `keyword`    — word-at-cursor is a C++ keyword (template, static,
 *                  using, decltype, ...) or the `...` parameter-pack
 *                  ellipsis. Runs FIRST so it short-circuits before
 *                  clangd / hover can surface the surrounding
 *                  declaration's content (e.g. variable type) by
 *                  mistake. See `keyword.ts` for the rationale.
 * - `clangd`     — `textDocument/symbolInfo` via vscode-clangd's exports.
 * - `hover`      — parse `vscode.executeHoverProvider` markdown output.
 * - `definition` — follow `vscode.executeDefinitionProvider` and parse
 *                  the surrounding namespace/class chain.
 * - `fallback`   — word-at-cursor + namespace heuristic.
 */
export type ResolverStrategyName =
    | 'keyword'
    | 'clangd'
    | 'hover'
    | 'definition'
    | 'fallback';

/**
 * A resolved fully-qualified C++ symbol. The chain stops at the first
 * strategy that returns a non-undefined result. `undefined` means
 * "miss"; the chain continues to the next strategy.
 */
export interface ResolvedSymbol {
    /** Canonical FQN, e.g. `std::vector::push_back`. Template args stripped. */
    fqn: string;
    /**
     * Optional originating strategy name for telemetry / debug logging.
     * The composer fills this in if a strategy doesn't set it itself.
     */
    source?: ResolverStrategyName;
    /** Optional clangd USR (stable cache key when available). */
    usr?: string;
    /** Optional anchor when the strategy produces overload-level info. */
    anchor?: string;
}

/**
 * A single resolver strategy. Takes a context, returns an FQN or
 * `undefined`. Must not throw on miss — return `undefined` instead.
 * Throwing is reserved for unexpected programmer errors and is logged
 * by the composer.
 */
export type ResolverStrategy = (
    ctx: ResolveContext
) => Promise<ResolvedSymbol | undefined>;

/**
 * The composed resolver presented to the rest of the extension. The
 * cursor-follow subscription in `extension.ts` calls `resolve` on every
 * debounced selection change; the cache layer (M4.5) wraps this with
 * `wrapWithCache`.
 */
export interface Resolver {
    resolve(
        document: vscode.TextDocument,
        position: vscode.Position
    ): Promise<ResolvedSymbol | undefined>;
    /** For tests / introspection. Strategy order is fixed at composition time. */
    readonly strategyOrder: readonly ResolverStrategyName[];
}
