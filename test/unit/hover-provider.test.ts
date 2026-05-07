// Unit tests for src/ui/hover-provider.ts (M5.2).
//
// Two layers under test, mirroring the source file's structure:
//   1. The pure `buildHoverMarkdown` builder — exhaustively cover the
//      branching (synopsis-only / paragraph-only / both / neither, and
//      attribution on/off) plus the structural invariants the M4.2
//      hover-parser strategy depends on (the `**cppreference** —`
//      provenance prefix, the `isTrusted.enabledCommands` allowlist,
//      the URL-encoded command-URI link).
//   2. `CppDocsHoverProvider.provideHover` against pure-mock deps —
//      bail-on-disabled, miss propagation through resolver / lookup,
//      ENOENT swallowing, and cancellation handling.
//
// We hand-roll a structural `MarkdownString` (`FakeMarkdown`) and inject
// it via `BuildHoverDeps.MarkdownStringCtor`. Importing the real
// `vscode.MarkdownString` would require the integration-test runner;
// the FSM under test is the appendMarkdown sequence + the `isTrusted`/
// `supportHtml` field assignments, both of which the structural stub
// faithfully reproduces.

import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';

// Minimal vscode mock — vitest can't import the real `vscode` (host
// runtime only). We stub just what `hover-provider.ts` touches at
// runtime: `MarkdownString` (constructed by the production builder when
// the test omits `MarkdownStringCtor`), `Hover` (the return wrapper),
// and `Uri.file` (used to set `MarkdownString.baseUri` so command-URI
// links resolve into the docset documents directory).
vi.mock('vscode', () => {
    class MarkdownString {
        value = '';
        isTrusted: boolean | { readonly enabledCommands?: readonly string[] } = false;
        supportHtml = false;
        supportThemeIcons: boolean;
        baseUri: { fsPath: string } | undefined;
        constructor(value?: string, supportThemeIcons = false) {
            this.value = value ?? '';
            this.supportThemeIcons = supportThemeIcons;
        }
        appendMarkdown(s: string): this {
            this.value += s;
            return this;
        }
        appendText(s: string): this {
            this.value += s;
            return this;
        }
        appendCodeblock(s: string, language?: string): this {
            this.value += '```' + (language ?? '') + '\n' + s + '\n```';
            return this;
        }
    }
    class Hover {
        public contents: unknown[];
        constructor(
            contents: unknown,
            public range?: unknown
        ) {
            this.contents = Array.isArray(contents) ? contents : [contents];
        }
    }
    const Uri = {
        file: (p: string): { fsPath: string } => ({ fsPath: p })
    };
    return { MarkdownString, Hover, Uri };
});

import {
    buildHoverMarkdown,
    CppDocsHoverProvider,
    HOVER_PROVENANCE_PREFIX,
    HOVER_TRUSTED_COMMANDS,
    type HoverProviderDeps
} from '../../src/ui/hover-provider.js';
import type { DocsetManager } from '../../src/docset/manager.js';
import type { DocsetRow, SymbolHit } from '../../src/docset/types.js';
import type { Resolver, ResolvedSymbol } from '../../src/resolver/types.js';
import {
    extractSnippet,
    type ExtractedSnippet
} from '../../src/webview-host/snippet.js';

// ---------------------------------------------------------------------------
// FakeMarkdown — structural stand-in for vscode.MarkdownString.
// ---------------------------------------------------------------------------

class FakeMarkdown {
    value = '';
    isTrusted: boolean | { readonly enabledCommands?: readonly string[] } = false;
    supportHtml = false;
    supportThemeIcons: boolean;
    baseUri: vscode.Uri | undefined;

    constructor(value?: string, supportThemeIcons = false) {
        this.value = value ?? '';
        this.supportThemeIcons = supportThemeIcons;
    }

    appendMarkdown(s: string): this {
        this.value += s;
        return this;
    }

    appendText(s: string): this {
        this.value += s;
        return this;
    }

    appendCodeblock(s: string, language?: string): this {
        this.value += '```' + (language ?? '') + '\n' + s + '\n```';
        return this;
    }
}

const FakeMarkdownCtor = FakeMarkdown as unknown as new (
    value?: string,
    supportThemeIcons?: boolean
) => vscode.MarkdownString;

// ---------------------------------------------------------------------------
// buildHoverMarkdown
// ---------------------------------------------------------------------------

describe('buildHoverMarkdown', () => {
    function build(
        overrides: Partial<Parameters<typeof buildHoverMarkdown>[0]> = {}
    ): FakeMarkdown {
        return buildHoverMarkdown({
            qualifiedName: 'std::vector::push_back',
            symbolId: 7,
            synopsisHtml: '<table><tr><td>void push_back(const T&amp; v);</td></tr></table>',
            paragraphHtml: '<p>Appends the given element to the end.</p>',
            pagePath: 'en/cpp/container/vector/push_back.html',
            docsetId: 1,
            attributionEnabled: true,
            MarkdownStringCtor: FakeMarkdownCtor,
            ...overrides
        }) as unknown as FakeMarkdown;
    }

    it('emits the **cppreference** provenance marker followed by the FQN', () => {
        const md = build();
        expect(md.value.startsWith(`${HOVER_PROVENANCE_PREFIX} — \`std::vector::push_back\``)).toBe(true);
        expect(md.value).toContain(`${HOVER_PROVENANCE_PREFIX} — \`std::vector::push_back\`\n\n`);
    });

    it('with both synopsis and paragraph, both appear with blank-line separators', () => {
        const md = build();
        expect(md.value).toContain('void push_back(const T&amp; v);');
        expect(md.value).toContain('Appends the given element');
        // Header → synopsis → paragraph → link → attribution.
        const headerIdx = md.value.indexOf(HOVER_PROVENANCE_PREFIX);
        const synopsisIdx = md.value.indexOf('void push_back');
        const paragraphIdx = md.value.indexOf('Appends');
        const linkIdx = md.value.indexOf('[Open full reference]');
        expect(headerIdx).toBeLessThan(synopsisIdx);
        expect(synopsisIdx).toBeLessThan(paragraphIdx);
        expect(paragraphIdx).toBeLessThan(linkIdx);
        // Synopsis followed by blank line before paragraph.
        expect(md.value).toMatch(/<\/table>\n\n<p>/);
    });

    it('synopsis only: paragraph absent and no double-paragraph break dangles before the link', () => {
        const md = build({ paragraphHtml: '' });
        expect(md.value).toContain('void push_back');
        expect(md.value).not.toContain('Appends');
        // Synopsis ends with one blank line (`\n\n`), then comes the link.
        expect(md.value).toMatch(/<\/table>\n\n\[Open full reference\]/);
    });

    it('paragraph only: synopsis absent and the paragraph is followed by the link', () => {
        const md = build({ synopsisHtml: '' });
        expect(md.value).not.toContain('void push_back');
        expect(md.value).toContain('Appends');
        expect(md.value).toMatch(/<\/p>\n\n\[Open full reference\]/);
    });

    it('neither synopsis nor paragraph: header followed directly by the link', () => {
        const md = build({ synopsisHtml: '', paragraphHtml: '' });
        expect(md.value).not.toContain('<p>');
        expect(md.value).not.toContain('<table>');
        expect(md.value).toMatch(
            new RegExp(
                `^\\*\\*cppreference\\*\\* — \`std::vector::push_back\`\\n\\n\\[Open full reference\\]`
            )
        );
    });

    it('isTrusted is the explicit allowlist object (gotcha #12 — never `true`)', () => {
        const md = build();
        expect(md.isTrusted).toEqual({
            enabledCommands: [...HOVER_TRUSTED_COMMANDS]
        });
        // Sanity: openSymbolFromTree + openCurrentInBrowser, plus
        // installCppreference (Fix C — the not-installed Hover variant
        // uses this third command-URI link).
        expect(HOVER_TRUSTED_COMMANDS).toEqual([
            'cppDocs.openSymbolFromTree',
            'cppDocs.openCurrentInBrowser',
            'cppDocs.installCppreference'
        ]);
    });

    it('supportHtml is true (so the snippet HTML renders, gotcha #13 allowlist applies)', () => {
        const md = build();
        expect(md.supportHtml).toBe(true);
    });

    it('command-URI encodes the symbol id so VSCode decodes a JSON args array', () => {
        const md = build({ symbolId: 12345 });
        const linkMatch = /\[Open full reference\]\(command:cppDocs\.openSymbolFromTree\?([^\)]+)\)/.exec(
            md.value
        );
        expect(linkMatch).not.toBeNull();
        const encoded = linkMatch![1]!;
        const decoded = decodeURIComponent(encoded);
        expect(JSON.parse(decoded)).toEqual([12345]);
    });

    it('attributionEnabled: true appends the CC BY-SA 3.0 attribution line', () => {
        const md = build({ attributionEnabled: true });
        expect(md.value).toContain('cppreference.com');
        expect(md.value).toContain('CC BY-SA 3.0');
        expect(md.value).toContain(
            'https://creativecommons.org/licenses/by-sa/3.0/'
        );
    });

    it('attributionEnabled: false omits the attribution line entirely', () => {
        const md = build({ attributionEnabled: false });
        // The footer text is gone (the upstream URL is also a footer-only string).
        expect(md.value).not.toContain('CC BY-SA 3.0');
        expect(md.value).not.toContain(
            'https://creativecommons.org/licenses/by-sa/3.0/'
        );
        // The link itself still references cppreference's openSymbolFromTree.
        expect(md.value).toContain('[Open full reference]');
    });
});

// ---------------------------------------------------------------------------
// CppDocsHoverProvider.provideHover
// ---------------------------------------------------------------------------

interface Harness {
    provider: CppDocsHoverProvider;
    resolverResolve: ReturnType<typeof vi.fn>;
    lookupExact: ReturnType<typeof vi.fn>;
    lookupBest: ReturnType<typeof vi.fn>;
    listDocsets: ReturnType<typeof vi.fn>;
    getDocsetById: ReturnType<typeof vi.fn>;
    readFile: ReturnType<typeof vi.fn>;
    statMtime: ReturnType<typeof vi.fn>;
    extractSnippetSpy: ReturnType<typeof vi.fn>;
    resolveResult: { value: ResolvedSymbol | undefined };
    lookupResult: { value: SymbolHit | undefined };
    enabled: { value: boolean };
    attributionEnabled: { value: boolean };
    htmlOnDisk: { value: string };
    readError: { value: NodeJS.ErrnoException | undefined };
    mtimeMs: { value: number };
}

function makeRow(overrides: Partial<DocsetRow> = {}): DocsetRow {
    return {
        id: 1,
        name: 'cppreference',
        source: 'cppreference',
        version: '20250101',
        rootPath: '/tmp/cppref',
        documentsDir: '/tmp/cppref/Resources/Documents',
        indexFormat: 'searchIndex',
        installedAt: 0,
        isActive: true,
        ...overrides
    };
}

function makeHit(overrides: Partial<SymbolHit> = {}): SymbolHit {
    return {
        id: 42,
        docsetId: 1,
        docsetName: 'cppreference',
        qualifiedName: 'std::vector::push_back',
        unqualified: 'push_back',
        parent: 'std::vector',
        kind: 'Method',
        filePath: 'en/cpp/container/vector/push_back.html',
        anchor: null,
        arglist: null,
        ...overrides
    };
}

function makeDoc(): vscode.TextDocument {
    return {
        uri: { toString: (): string => 'file:///t.cpp' },
        version: 1,
        languageId: 'cpp',
        getText: () => '',
        lineAt: () => ({ text: '' }),
        lineCount: 0
    } as unknown as vscode.TextDocument;
}

function makePos(): vscode.Position {
    return { line: 0, character: 0 } as unknown as vscode.Position;
}

function makeToken(cancelled = false): vscode.CancellationToken {
    return {
        isCancellationRequested: cancelled,
        onCancellationRequested: (() => ({ dispose() { } })) as unknown as vscode.CancellationToken['onCancellationRequested']
    } as vscode.CancellationToken;
}

function makeHarness(): Harness {
    const resolveResult: { value: ResolvedSymbol | undefined } = { value: undefined };
    const lookupResult: { value: SymbolHit | undefined } = { value: undefined };
    const enabled = { value: true };
    const attributionEnabled = { value: true };
    const htmlOnDisk = {
        value:
            '<html><body><table class="t-dcl-begin"><tr><td>void push_back(const T&amp; v);</td></tr></table><p>Appends the given element to the end.</p></body></html>'
    };
    const readError: { value: NodeJS.ErrnoException | undefined } = {
        value: undefined
    };
    const mtimeMs = { value: 1 };

    const resolverResolve = vi.fn(async () => resolveResult.value);
    const resolver: Resolver = {
        strategyOrder: ['clangd', 'hover', 'definition', 'fallback'],
        resolve: resolverResolve as unknown as Resolver['resolve']
    };

    const lookupExact = vi.fn(() => lookupResult.value);
    const lookupBest = vi.fn(() => lookupResult.value);
    const listDocsets = vi.fn(() => [makeRow()]);
    const getDocsetById = vi.fn((_id: number) => makeRow());
    const docsets = {
        lookupExact,
        lookupBest,
        listDocsets,
        getDocsetById
    } as unknown as DocsetManager;

    const readFile = vi.fn(async (_p: string): Promise<string> => {
        if (readError.value) throw readError.value;
        return htmlOnDisk.value;
    });

    const statMtime = vi.fn(async (_p: string): Promise<number> => mtimeMs.value);

    // Wrap the real extractor so the integration test can count calls.
    const extractSnippetSpy = vi.fn(
        (html: string, options?: { maxChars?: number }): ExtractedSnippet =>
            extractSnippet(html, options)
    );

    const deps: HoverProviderDeps = {
        resolver,
        docsets,
        maxChars: () => 600,
        enabled: () => enabled.value,
        attributionEnabled: () => attributionEnabled.value,
        readFile,
        statMtime,
        extractSnippet: extractSnippetSpy
    };

    return {
        provider: new CppDocsHoverProvider(deps),
        resolverResolve,
        lookupExact,
        lookupBest,
        listDocsets,
        getDocsetById,
        readFile,
        statMtime,
        extractSnippetSpy,
        resolveResult,
        lookupResult,
        enabled,
        attributionEnabled,
        htmlOnDisk,
        readError,
        mtimeMs
    };
}

describe('CppDocsHoverProvider.provideHover', () => {
    it('bails immediately when cppDocs.hover.enabled is false; resolver not called', async () => {
        const h = makeHarness();
        h.enabled.value = false;

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeUndefined();
        expect(h.resolverResolve).not.toHaveBeenCalled();
        expect(h.lookupBest).not.toHaveBeenCalled();
    });

    it('returns undefined when the resolver misses; lookupExact not called', async () => {
        const h = makeHarness();
        h.resolveResult.value = undefined;

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeUndefined();
        expect(h.resolverResolve).toHaveBeenCalledTimes(1);
        expect(h.lookupBest).not.toHaveBeenCalled();
    });

    it('returns a "no page" hover when lookupBest misses; readFile not called (L-3)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = undefined;

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeDefined();
        expect(h.lookupBest).toHaveBeenCalledWith('std::vector::push_back');
        expect(h.readFile).not.toHaveBeenCalled();
        const contents = (result as unknown as { contents: Array<{ value?: string } | string> }).contents;
        const first = contents[0];
        const text =
            typeof first === 'string' ? first : (first as { value?: string }).value ?? '';
        expect(text).toContain(HOVER_PROVENANCE_PREFIX);
        expect(text).toContain('no page for');
        expect(text).toContain('std::vector::push_back');
    });

    it('happy path: returns a Hover whose markdown carries our provenance + FQN', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeDefined();
        // `vscode.Hover.contents` is `MarkdownString | MarkedString | …` —
        // we're running outside the integration host so the constructor we
        // care about is `vscode.MarkdownString`, but at runtime here the
        // mocked vscode shim provides whatever the test runner injects. The
        // useful invariant is that the `value` field round-trips our content.
        const contents = (result as unknown as { contents: Array<{ value?: string } | string> }).contents;
        expect(Array.isArray(contents)).toBe(true);
        const first = contents[0];
        const text =
            typeof first === 'string' ? first : (first as { value?: string }).value ?? '';
        expect(text.startsWith(`${HOVER_PROVENANCE_PREFIX} — \`std::vector::push_back\``)).toBe(
            true
        );
        expect(text).toContain('void push_back');
        expect(text).toContain('Appends');
        expect(text).toContain('[Open full reference]');
        // `path.join` uses the platform separator, so normalize to POSIX
        // before substring-matching to keep the assertion cross-platform.
        const calledWith = h.readFile.mock.calls[0]?.[0]?.replace(/\\/g, '/');
        expect(calledWith).toContain('en/cpp/container/vector/push_back.html');
    });

    it('strips an "#anchor" suffix from filePath before joining the docset documents dir', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit({
            filePath: 'en/cpp/container/vector/push_back.html#some-anchor'
        });

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeDefined();
        // The reader received a path WITHOUT the `#anchor` fragment.
        const calledWith = h.readFile.mock.calls[0]?.[0] as string | undefined;
        expect(calledWith).toBeDefined();
        expect(calledWith!.endsWith('push_back.html')).toBe(true);
        expect(calledWith).not.toContain('#');
    });

    it('returns undefined when readFile throws ENOENT (index ↔ disk drift)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();
        const err = new Error('not found') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        h.readError.value = err;

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeUndefined();
    });

    it('returns undefined when readFile throws an unexpected I/O error (no escalation)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        h.readError.value = err;

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        // Per provider doc-comment: I/O errors collapse to a no-hover so the
        // editor doesn't surface an error popup mid-typing.
        expect(result).toBeUndefined();
    });

    it('returns undefined when the cancellation token fires after the resolver resolves', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        // Token fires immediately — the post-resolver guard in
        // `provideHover` short-circuits before `lookupExact` runs.
        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken(true));

        expect(result).toBeUndefined();
        expect(h.lookupBest).not.toHaveBeenCalled();
    });

    it('M6.3.A: hovering on the same symbol twice invokes extractSnippet exactly once (snippet cache hit)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        await h.provider.provideHover(makeDoc(), makePos(), makeToken());
        await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(h.extractSnippetSpy).toHaveBeenCalledTimes(1);
        // readFile should also collapse to one call per unique cache key
        // (the second hit is served from the cache without a fresh read).
        expect(h.readFile).toHaveBeenCalledTimes(1);
        // statMtime IS called both times — the mtime check is the cache
        // invalidation key, so we must always look at it.
        expect(h.statMtime).toHaveBeenCalledTimes(2);
    });

    it('M6.3.A: a changed mtime invalidates the cache entry (re-extracts)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        await h.provider.provideHover(makeDoc(), makePos(), makeToken());
        h.mtimeMs.value = 9999; // simulate file rewrite (e.g. cppreference reinstall)
        await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(h.extractSnippetSpy).toHaveBeenCalledTimes(2);
        expect(h.readFile).toHaveBeenCalledTimes(2);
    });

    it('Fix C: when hasAnyDocset() returns false and resolver hits, returns the install-link Hover with the **cppreference** marker', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        // We don't set lookupResult — the not-installed branch must
        // short-circuit before `lookupExact` even runs.
        const deps: HoverProviderDeps = {
            resolver: h.provider['deps'].resolver,
            docsets: h.provider['deps'].docsets,
            maxChars: h.provider['deps'].maxChars,
            enabled: h.provider['deps'].enabled,
            attributionEnabled: h.provider['deps'].attributionEnabled,
            readFile: h.readFile as unknown as HoverProviderDeps['readFile'],
            statMtime: h.statMtime as unknown as HoverProviderDeps['statMtime'],
            extractSnippet:
                h.extractSnippetSpy as unknown as HoverProviderDeps['extractSnippet'],
            hasAnyDocset: () => false
        };
        const provider = new CppDocsHoverProvider(deps);

        const result = await provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeDefined();
        expect(h.lookupBest).not.toHaveBeenCalled();
        expect(h.readFile).not.toHaveBeenCalled();
        const contents = (result as unknown as { contents: Array<{ value?: string } | string> }).contents;
        const first = contents[0];
        const text =
            typeof first === 'string' ? first : (first as { value?: string }).value ?? '';
        // Provenance marker is preserved so M4.2's hover-parser still filters
        // out our own contributions (gotcha #10/#11).
        expect(text).toContain(HOVER_PROVENANCE_PREFIX);
        expect(text).toContain('not installed');
        expect(text).toContain('command:cppDocs.installCppreference');
    });

    it('Fix C: when hasAnyDocset() returns true (or is omitted), the existing happy path is unchanged', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        // Default harness omits `hasAnyDocset` → behavior must match the
        // legacy code path (resolver → lookupExact → readFile).
        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeDefined();
        expect(h.lookupBest).toHaveBeenCalled();
        expect(h.readFile).toHaveBeenCalled();
    });

    // Fix B (iter 37) — diagnostic log injection. Mirrors the
    // cursor-follow logging contract; events are pinned by name so a
    // rename is a deliberate, user-visible change.
    describe('Fix B — diagnostic logging', () => {
        it('emits hover.skip.disabled when enabled() is false', async () => {
            const h = makeHarness();
            h.enabled.value = false;
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            expect(log).toHaveBeenCalledWith('hover.skip.disabled');
        });

        it('emits hover.resolve.miss when resolver returns undefined', async () => {
            const h = makeHarness();
            h.resolveResult.value = undefined;
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            expect(log).toHaveBeenCalledWith('hover.resolve.miss');
        });

        it('emits hover.resolve.hit + hover.lookup.hit.fresh on the happy path', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
            h.lookupResult.value = makeHit();
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            const events = log.mock.calls.map((c) => c[0]);
            expect(events).toContain('hover.resolve.hit');
            expect(events).toContain('hover.lookup.hit.fresh');
            const resolveHit = log.mock.calls.find(
                (c) => c[0] === 'hover.resolve.hit'
            );
            expect(resolveHit?.[1]).toMatchObject({
                fqn: 'std::vector::push_back',
                source: 'clangd'
            });
        });

        it('emits hover.lookup.hit.cached on a second identical hover (cache hit)', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
            h.lookupResult.value = makeHit();
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            log.mockClear();
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            const events = log.mock.calls.map((c) => c[0]);
            expect(events).toContain('hover.lookup.hit.cached');
            expect(events).not.toContain('hover.lookup.hit.fresh');
        });

        it('emits hover.lookup.miss.no-docsets when hasAnyDocset returns false', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'X', source: 'clangd' };
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                hasAnyDocset: () => false,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            expect(log).toHaveBeenCalledWith('hover.lookup.miss.no-docsets', {
                fqn: 'X'
            });
        });

        it('emits hover.lookup.miss when the resolver hits but lookupExact misses', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'mystery::sym', source: 'fallback' };
            h.lookupResult.value = undefined;
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            expect(log).toHaveBeenCalledWith('hover.lookup.miss', {
                fqn: 'mystery::sym'
            });
        });

        it('emits hover.snippet.empty when both synopsis and paragraph extracted as empty', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
            h.lookupResult.value = makeHit();
            h.htmlOnDisk.value = '<html><body><p></p></body></html>';
            const log = vi.fn();
            const provider = new CppDocsHoverProvider({
                ...(h.provider as unknown as { deps: HoverProviderDeps }).deps,
                log
            });
            await provider.provideHover(makeDoc(), makePos(), makeToken());
            const events = log.mock.calls.map((c) => c[0]);
            expect(events).toContain('hover.snippet.empty');
        });
    });

    it('returns undefined when the docset row is missing for the looked-up symbol', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        // Hit references docsetId=1 but getDocsetById returns undefined → orphan
        // row case (a rare race during a docset removal between lookup and
        // row resolution).
        h.lookupResult.value = makeHit({ docsetId: 1 });
        h.getDocsetById.mockReturnValue(undefined);

        const result = await h.provider.provideHover(makeDoc(), makePos(), makeToken());

        expect(result).toBeUndefined();
        expect(h.readFile).not.toHaveBeenCalled();
    });
});
