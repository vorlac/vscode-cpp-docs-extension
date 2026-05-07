// HoverProvider for `cpp` and `c` languages (M5.2).
//
// Pipeline per `provideHover`:
//   1. Bail if `cppDocs.hover.enabled` is false.
//   2. Resolve FQN at the cursor position via the M4 resolver chain.
//   3. Look up the FQN in the aggregate index → docset row + page path.
//   4. Read the page's HTML from disk (cached only at the OS level for
//      MVP — a future M6 polish pass may add an in-memory LRU).
//   5. Run the M5.1 snippet extractor over the HTML.
//   6. Build a `MarkdownString` (`supportHtml: true`, `isTrusted` with an
//      explicit `enabledCommands` allowlist per docs/06-gotchas.md #12)
//      and return it as a `vscode.Hover`.
//
// The markdown payload always opens with `**cppreference** — \`<fqn>\``
// (the same provenance marker the M4.2 hover-parser strategy uses to
// filter out our own hovers when reading `vscode.executeHoverProvider`
// output — docs/06-gotchas.md #10/#11). Removing or rewording the
// marker would re-introduce the parser-feedback loop.
//
// Per docs/02-architecture.md § "Resolver wiring" + "VSCode contribution
// shape", docs/04-rendering.md § "Snippet extraction (for hover)", and
// docs/05-plan.md § "M5 — Hover tooltip".

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { DocsetManager } from '../docset/manager.js';
import type { Resolver } from '../resolver/index.js';
import { highlightSynopsisHtml } from '../webview-host/hover-highlight.js';
import { extractSnippet, type ExtractedSnippet } from '../webview-host/snippet.js';
import {
    createSnippetCache,
    type SnippetCache
} from '../webview-host/snippet-cache.js';

/**
 * Commands the hover markdown's command-URI links may invoke. Matches
 * what `buildHoverMarkdown` emits — keep these two in sync. We pass the
 * exact list to `MarkdownString.isTrusted.enabledCommands` rather than
 * `isTrusted: true` because the latter would let any markdown content
 * (including embedded cppreference snippets) trigger arbitrary VSCode
 * commands (docs/06-gotchas.md #12).
 *
 * `cppDocs.installCppreference` is included for the Fix C "not
 * installed" hover variant (returned when `hasAnyDocset()` is false).
 */
export const HOVER_TRUSTED_COMMANDS: readonly string[] = [
    'cppDocs.openSymbolFromTree',
    'cppDocs.openCurrentInBrowser',
    'cppDocs.installCppreference'
];

/**
 * Provenance prefix the M4.2 hover-parser strategy uses to detect (and
 * skip) our own contributions when surveying
 * `vscode.executeHoverProvider` results. Changing this string requires
 * the matching update in `src/resolver/hover-parser.ts`.
 */
export const HOVER_PROVENANCE_PREFIX = '**cppreference**';

/**
 * Diagnostic logger. Defaults to no-op so the existing test harnesses
 * (which omit the field) stay green; production wiring injects
 * `logEvent` from `src/util/output.ts`. See cursor-follow's
 * `CursorFollowLog` for parallel rationale.
 */
export type HoverProviderLog = (
    event: string,
    fields?: Record<string, unknown>
) => void;

export interface HoverProviderDeps {
    resolver: Resolver;
    docsets: DocsetManager;
    /**
     * Optional per-hover character cap. Production no longer sets one
     * — the hover renders the full snippet (matching the docs panel)
     * per the user-requested ergonomics. Tests may still pass a finite
     * value to exercise the truncation path inside `extractSnippet`.
     */
    maxChars?: () => number;
    /** Returns whether the hover should be active (`cppDocs.hover.enabled`). */
    enabled: () => boolean;
    /** Returns whether the attribution footer line is rendered into the hover. */
    attributionEnabled: () => boolean;
    /**
     * Optional structured logger — see `HoverProviderLog`. Defaults to a
     * no-op so existing tests don't have to inject one.
     */
    log?: HoverProviderLog;
    /**
     * Returns true when at least one docset is installed. When false and
     * the resolver returns an FQN, `provideHover` returns a "not
     * installed — Install (~7 MB)" Hover instead of `undefined`. The
     * provenance prefix is preserved so the M4.2 hover-parser still
     * filters our content out (gotcha #10/#11). Optional for tests that
     * exercise pre-Fix-C behavior; defaults to true (i.e. assume
     * docsets exist) when omitted.
     */
    hasAnyDocset?: () => boolean;
    /** Inject a file reader for tests. Defaults to `fs.promises.readFile(path, 'utf-8')`. */
    readFile?: (absPath: string) => Promise<string>;
    /**
     * Inject a stat function for tests. Defaults to
     * `fs.promises.stat(path).then(s => s.mtimeMs)`. The hover provider
     * uses the mtime to key the snippet cache so an upstream
     * cppreference reinstall (which rewrites the file) naturally
     * invalidates the entry.
     */
    statMtime?: (absPath: string) => Promise<number>;
    /**
     * Inject the M5.1 snippet extractor for tests so the integration
     * test in `hover-provider.test.ts` can assert it's called exactly
     * once per (filePath, mtimeMs, maxChars) tuple. Defaults to the real
     * `extractSnippet`.
     */
    extractSnippet?: (
        html: string,
        options?: { maxChars?: number }
    ) => ExtractedSnippet;
    /**
     * Snippet cache. Defaults to a fresh in-memory LRU per provider
     * instance. Tests inject a shared cache to count hits and misses
     * directly.
     */
    cache?: SnippetCache;
}

export class CppDocsHoverProvider implements vscode.HoverProvider {
    private readonly cache: SnippetCache;
    private readonly extract: (
        html: string,
        options?: { maxChars?: number }
    ) => ExtractedSnippet;
    private readonly log: HoverProviderLog;
    /**
     * H-1 reentrancy guard. The M4.2 hover-parser strategy fires
     * `vscode.executeHoverProvider`, which calls every registered hover
     * provider — including this one. Without the guard, a clangd-less /
     * stdlib-less file that bottoms out into the hover-parser path can
     * recurse N levels deep, paying ~250 ms of `setTimeout` per frame
     * before unwinding. The set is keyed by `(uri, version, line, char)`
     * so concurrent independent hovers don't block each other.
     */
    private readonly resolving = new Set<string>();

    constructor(private readonly deps: HoverProviderDeps) {
        this.cache = deps.cache ?? createSnippetCache();
        this.extract = deps.extractSnippet ?? extractSnippet;
        this.log = deps.log ?? ((): void => { });
    }

    async provideHover(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        if (!this.deps.enabled()) {
            this.log('hover.skip.disabled');
            return undefined;
        }

        const reentrancyKey = `${document.uri.toString()}|${document.version}|${position.line}:${position.character}`;
        if (this.resolving.has(reentrancyKey)) {
            // The hover-parser strategy is invoking executeHoverProvider on
            // this exact position; bailing here breaks the recursion without
            // affecting the outer call (it re-runs without the guard set).
            this.log('hover.skip.reentrant');
            return undefined;
        }
        this.resolving.add(reentrancyKey);
        try {
            return await this.provideHoverInner(document, position, token);
        } finally {
            this.resolving.delete(reentrancyKey);
        }
    }

    private async provideHoverInner(
        document: vscode.TextDocument,
        position: vscode.Position,
        token: vscode.CancellationToken
    ): Promise<vscode.Hover | undefined> {
        const resolved = await this.deps.resolver.resolve(document, position);
        if (token.isCancellationRequested) return undefined;
        if (!resolved) {
            this.log('hover.resolve.miss');
            return undefined;
        }
        this.log('hover.resolve.hit', {
            fqn: resolved.fqn,
            source: resolved.source
        });

        // Fix C — when zero docsets are installed, surface a one-line
        // hover that explains why nothing's coming back and offers the
        // install command. The provenance prefix is the same one the M4.2
        // hover-parser strategy uses to filter our own output, so this
        // variant doesn't re-introduce the parser-feedback loop
        // (docs/06-gotchas.md #10/#11).
        if (this.deps.hasAnyDocset && !this.deps.hasAnyDocset()) {
            this.log('hover.lookup.miss.no-docsets', { fqn: resolved.fqn });
            const md = new vscode.MarkdownString(undefined, true);
            md.supportHtml = true;
            md.isTrusted = { enabledCommands: [...HOVER_TRUSTED_COMMANDS] };
            md.appendMarkdown(
                `${HOVER_PROVENANCE_PREFIX} not installed. [Install (~7 MB)](command:cppDocs.installCppreference)`
            );
            return new vscode.Hover(md);
        }

        const hit = this.deps.docsets.lookupBest(resolved.fqn);
        if (!hit) {
            // L-3 — surface a tiny "no page" hover so the user sees that we
            // resolved the symbol but couldn't find a docs page for it,
            // mirroring the panel's `renderMissPlaceholder` semantics. The
            // provenance prefix keeps M4.2's hover-parser filter intact.
            this.log('hover.lookup.miss', { fqn: resolved.fqn });
            const md = new vscode.MarkdownString(undefined, true);
            md.supportHtml = true;
            md.isTrusted = { enabledCommands: [...HOVER_TRUSTED_COMMANDS] };
            const safe = resolved.fqn.replace(/`/g, "'");
            md.appendMarkdown(
                `${HOVER_PROVENANCE_PREFIX} — no page for \`${safe}\``
            );
            return new vscode.Hover(md);
        }

        const row = this.deps.docsets.getDocsetById(hit.docsetId);
        if (!row) {
            this.log('hover.lookup.miss.no-row', {
                fqn: resolved.fqn,
                docsetId: hit.docsetId
            });
            return undefined;
        }

        // The aggregate index sometimes encodes anchors in `file_path` per the
        // M1 schema (`page.html#frag`). The HTML on disk is keyed by the bare
        // page path; the anchor is only meaningful in the rendered webview.
        const filePathNoAnchor = stripAnchor(hit.filePath);
        const absPath = path.join(row.documentsDir, filePathNoAnchor);
        // Default to `Infinity` so the hover shows the full first
        // paragraph / synopsis. Tests inject a finite cap to exercise the
        // truncation path in `extractSnippet` without producing a giant
        // expected fixture.
        const maxChars = this.deps.maxChars?.() ?? Number.POSITIVE_INFINITY;

        // Stat the file to derive the cache key. Failures (ENOENT) collapse
        // to mtimeMs=0 so a missing-file path still returns no-hover via the
        // file-read step below; we don't try to short-circuit here because
        // the read-error path emits the same outcome.
        const statMtime =
            this.deps.statMtime ??
            (async (p: string): Promise<number> => {
                const s = await fs.stat(p);
                return s.mtimeMs;
            });

        let mtimeMs = 0;
        try {
            mtimeMs = await statMtime(absPath);
        } catch {
            // fall through — readFile below will produce the canonical no-hover.
        }
        if (token.isCancellationRequested) return undefined;

        const cacheKey = { filePath: absPath, mtimeMs, maxChars };
        let snippet = this.cache.get(cacheKey);
        const cachedHit = snippet !== undefined;

        if (snippet === undefined) {
            const reader =
                this.deps.readFile ?? ((p: string): Promise<string> => fs.readFile(p, 'utf-8'));

            let html: string;
            try {
                html = await reader(absPath);
            } catch (err) {
                // ENOENT (and the cousin ENOTDIR) are expected: the index can drift
                // from disk if a docset's documents directory is partially deleted
                // or if the docset lists pages that aren't present on disk. Other I/O
                // errors are also collapsed to "no hover" rather than escalated —
                // a hover provider that throws is shown as an error popup by the
                // editor, which is a worse UX than just skipping.
                const code = (err as NodeJS.ErrnoException | undefined)?.code;
                this.log('hover.lookup.miss.read-error', {
                    fqn: resolved.fqn,
                    code: code ?? 'unknown'
                });
                if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
                return undefined;
            }
            if (token.isCancellationRequested) return undefined;

            snippet = this.extract(html, { maxChars });
            this.cache.set(cacheKey, snippet);
        }

        this.log(cachedHit ? 'hover.lookup.hit.cached' : 'hover.lookup.hit.fresh', {
            fqn: resolved.fqn,
            pagePath: filePathNoAnchor
        });
        if (!snippet.synopsisHtml && !snippet.paragraphHtml) {
            this.log('hover.snippet.empty', {
                fqn: resolved.fqn,
                pagePath: filePathNoAnchor
            });
        }

        const md = buildHoverMarkdown({
            qualifiedName: hit.qualifiedName,
            symbolId: hit.id,
            synopsisHtml: highlightSynopsisHtml(snippet.synopsisHtml),
            paragraphHtml: snippet.paragraphHtml,
            pagePath: filePathNoAnchor,
            docsetId: hit.docsetId,
            attributionEnabled: this.deps.attributionEnabled(),
            // M-1 fix — baseUri must be the page's own directory so
            // cppreference's relative paths (`../../common/ext.css` etc.)
            // resolve correctly. Pointing at `documentsDir` instead made
            // every relative URL exit the docset (`documentsDir/../../common/...`),
            // breaking inline images in hovers.
            pageDir: path.dirname(absPath)
        });

        return new vscode.Hover(md);
    }
}

/** Pure: build the MarkdownString content for a resolved hit + extracted snippet. */
export interface BuildHoverDeps {
    qualifiedName: string;
    symbolId: number;
    synopsisHtml: string;
    paragraphHtml: string;
    /** Page path under docset, retained for future link-emission (M6). */
    pagePath: string;
    docsetId: number;
    /** Mirrors `cppDocs.attribution.enabled`. */
    attributionEnabled: boolean;
    /**
     * Absolute path to the page's own directory (i.e.
     * `path.dirname(absPath)`). When provided we set
     * `MarkdownString.baseUri` to the directory URL so relative
     * `<img src="...">` and `<a href="...">` references in the
     * cppreference HTML resolve correctly — cppreference's pages use
     * paths like `../../common/ext.css` that only resolve against the
     * page's own directory.
     *
     * Tests omit this so the builder stays trivially checkable;
     * production wiring always sets it.
     */
    pageDir?: string;
    /** @deprecated Use `pageDir` instead. Kept for legacy callers/tests. */
    documentsDir?: string;
    /**
     * Constructor for `vscode.MarkdownString`. Defaulted to the real
     * `vscode.MarkdownString`; tests inject a structural stub.
     */
    MarkdownStringCtor?: new (
        value?: string,
        supportThemeIcons?: boolean
    ) => vscode.MarkdownString;
}

/**
 * Build the hover markdown for a resolved docs hit. Pure (no fs / no
 * resolver) so unit tests cover every shape combination.
 */
export function buildHoverMarkdown(deps: BuildHoverDeps): vscode.MarkdownString {
    const Ctor = deps.MarkdownStringCtor ?? vscode.MarkdownString;
    const md = new Ctor(undefined, true);
    md.supportHtml = true;
    // Object form is mandatory — `isTrusted: true` would enable arbitrary
    // command-URI invocation by any rendered markdown content (gotcha #12).
    md.isTrusted = {
        enabledCommands: [...HOVER_TRUSTED_COMMANDS]
    };
    const baseDir = deps.pageDir ?? deps.documentsDir;
    if (baseDir !== undefined) {
        // VSCode resolves relative URIs against `baseUri` only when it
        // ends with a `/` (otherwise the last segment is treated as the
        // file being replaced). Append the trailing path separator so
        // `../common/ext.css` walks up one directory rather than
        // discarding `baseDir`'s last segment.
        const trailing = baseDir.endsWith('/') || baseDir.endsWith('\\') ? '' : '/';
        md.baseUri = vscode.Uri.file(baseDir + trailing);
    }

    md.appendMarkdown(`${HOVER_PROVENANCE_PREFIX} — \`${sanitizeForMarkdown(deps.qualifiedName)}\`\n\n`);
    if (deps.synopsisHtml) {
        md.appendMarkdown(deps.synopsisHtml);
        md.appendMarkdown('\n\n');
    }
    if (deps.paragraphHtml) {
        md.appendMarkdown(deps.paragraphHtml);
        md.appendMarkdown('\n\n');
    }
    md.appendMarkdown(
        `[Open full reference](command:cppDocs.openSymbolFromTree?${encodeURIComponent(
            JSON.stringify([deps.symbolId])
        )})`
    );
    if (deps.attributionEnabled) {
        md.appendMarkdown(
            `\n\n_Source: cppreference.com — Licensed under [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/)_`
        );
    }
    return md;
}

function sanitizeForMarkdown(name: string): string {
    return name.replace(/`/g, "'").replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripAnchor(filePath: string): string {
    const hash = filePath.indexOf('#');
    return hash >= 0 ? filePath.slice(0, hash) : filePath;
}
