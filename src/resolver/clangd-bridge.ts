// Strategy 1 — clangd LSP bridge.
//
// Per docs/03-symbol-resolution.md § "Strategy 1 — clangd extension
// exports": ask the `vscode-clangd` extension's exported language
// client for `textDocument/symbolInfo` at the cursor and combine the
// returned `(name, containerName)` pair into a canonical FQN.
//
// Failure modes (per docs/06-gotchas.md items 20, 21):
//   - vscode-clangd not installed       → silent miss
//   - vscode-clangd activation throws   → silent miss
//   - exports surface absent / stale    → silent miss
//   - clangd version >= 23 (request was removed in clangd-23) → silent miss
//   - LSP request rejects               → silent miss
//   - LSP returns []                    → silent miss
//
// Throwing `AbortError` on `ctx.signal.aborted` lets the composer
// (M4.6) treat aborted strategies as misses without ambiguity.
//
// `vscode` is dependency-injected so this module can be unit-tested
// without spinning up the extension host.
import type * as vscode from 'vscode';
import type {
    ResolveContext,
    ResolvedSymbol,
    ResolverStrategy
} from './types.js';
import { stripAbiNamespaces, stripTemplateArgs } from '../util/fqn.js';
import { makeAbortError, isAbortError, raceWithAbort } from '../util/abort.js';

/**
 * Shape of `vscode-clangd`'s exports — undocumented (per gotcha 21),
 * treat as untyped and probe at runtime. Only the surface this strategy
 * actually touches is modeled here.
 */
export interface ClangdExports {
    languageClient?: {
        sendRequest<T>(method: string, params: unknown): Promise<T>;
        initializeResult?:
        | { serverInfo?: { name?: string; version?: string } }
        | undefined;
    };
}

/**
 * Result element shape from `textDocument/symbolInfo`. clangd returns
 * an array; we take the first element.
 *
 * See https://clangd.llvm.org/extensions#symbol-info-request.
 */
export interface ClangdSymbolInfo {
    name: string;
    containerName?: string;
    usr?: string;
}

export interface ClangdBridgeDeps {
    /**
     * Inject vscode for tests; in production, pass
     * `import * as vscode from 'vscode'`.
     */
    vscode: typeof vscode;
    /**
     * The extension ID to look up; defaults to
     * `'llvm-vs-code-extensions.vscode-clangd'`.
     */
    extensionId?: string;
}

const DEFAULT_EXTENSION_ID = 'llvm-vs-code-extensions.vscode-clangd';

/**
 * Pure helper: parse clangd's `serverInfo.version`, return the major
 * version (e.g. 22, 23, 24). Returns `undefined` if the version isn't
 * parseable. Exported for testing and reuse by M4.2.
 *
 * clangd's `version` is sometimes a bare semver (`"22.1.0"`,
 * `"23.0.0-rc1"`) and sometimes the LLVM build banner
 * (`"clangd version 21.1.0 (https://...)"`). We grep for the first
 * sequence of digits that looks like a version.
 */
export function parseClangdMajorVersion(
    version: string | undefined
): number | undefined {
    if (typeof version !== 'string' || version.length === 0) return undefined;
    const m = /(\d+)\.\d+(?:\.\d+)?/.exec(version);
    if (!m) return undefined;
    const major = Number.parseInt(m[1] ?? '', 10);
    return Number.isFinite(major) ? major : undefined;
}

/**
 * Pure helper: combine clangd's `(name, containerName)` into a
 * canonical FQN. Strips template arg lists from `containerName`
 * (`std::vector<int, std::allocator<int>>` → `std::vector`) by
 * walking the string and dropping anything inside balanced angle
 * brackets. This is the normalization called out by docs/06-gotchas.md
 * item 22.
 *
 * Bare names (no container) are returned without a `::` prefix.
 * If `name` is empty, returns `''` — the caller treats this as a miss.
 *
 * Note: `<` / `>` inside a `containerName` template-arg list are
 * always balanced in clangd's output; we don't attempt to recover
 * from malformed input.
 */
export function buildFqnFromSymbolInfo(info: ClangdSymbolInfo): string {
    const name = info.name ?? '';
    if (name.length === 0) return '';
    const container = stripAbiNamespaces(stripTemplateArgs(info.containerName ?? ''));
    if (container.length === 0) return name;
    return `${container}::${name}`;
}

/**
 * Build a resolver strategy bound to the given vscode runtime.
 *
 * The returned strategy:
 *   1. looks up the clangd extension; misses if absent
 *   2. activates it if needed; misses on activation error
 *   3. probes `exports.languageClient`; misses if absent
 *   4. checks `serverInfo.version`; misses if major >= 23
 *   5. sends `textDocument/symbolInfo`; misses on reject or empty
 *   6. honors `ctx.signal` — throws `AbortError` if aborted before the
 *      LSP request resolves
 */
export function createClangdStrategy(
    deps: ClangdBridgeDeps
): ResolverStrategy {
    const vscodeApi = deps.vscode;
    const extensionId = deps.extensionId ?? DEFAULT_EXTENSION_ID;

    return async function clangdStrategy(
        ctx: ResolveContext
    ): Promise<ResolvedSymbol | undefined> {
        if (ctx.signal.aborted) throw makeAbortError();

        const ext = vscodeApi.extensions.getExtension<ClangdExports>(extensionId);
        if (!ext) return undefined;

        if (!ext.isActive) {
            try {
                await ext.activate();
            } catch {
                return undefined;
            }
        }

        const api = ext.exports as ClangdExports | null | undefined;
        if (api === null || api === undefined) return undefined;
        const client = api.languageClient;
        if (!client) return undefined;

        const version = client.initializeResult?.serverInfo?.version;
        const major = parseClangdMajorVersion(version);
        if (major !== undefined && major >= 23) return undefined;

        const params = {
            textDocument: { uri: ctx.document.uri.toString() },
            position: {
                line: ctx.position.line,
                character: ctx.position.character
            }
        };

        let result: ClangdSymbolInfo[] | undefined;
        try {
            result = await raceWithAbort(
                client.sendRequest<ClangdSymbolInfo[]>(
                    'textDocument/symbolInfo',
                    params
                ),
                ctx.signal
            );
        } catch (err) {
            if (isAbortError(err)) throw err;
            return undefined;
        }

        if (!Array.isArray(result) || result.length === 0) return undefined;
        const first = result[0];
        if (!first) return undefined;

        const fqn = buildFqnFromSymbolInfo(first);
        if (fqn.length === 0) return undefined;

        return {
            fqn,
            source: 'clangd',
            ...(typeof first.usr === 'string' && first.usr.length > 0
                ? { usr: first.usr }
                : {})
        };
    };
}

