// Unit tests for the cursor-follow handler (M4.6).
//
// `handleCursorChange` is the body of the debounced
// `onDidChangeTextEditorSelection` callback in `extension.ts`. We
// inject all vscode and surface touchpoints so the test exercises the
// branching behavior directly:
//   - followCursor=false → no resolver call
//   - wrong languageId → no resolver call
//   - resolver miss → no surface activity (sticky)
//   - resolver hit + lookupExact miss + onMissBehavior='stay' → no
//     surface change
//   - resolver hit + lookupExact succeeds → ensureActiveSurface,
//     history.push, loadPage all called
//   - same hit twice → second invocation deduplicated by lastShownSymbolId
//   - showLink / clearPanel branches are TODOs for M6 — we only assert
//     that no surface mutation happens today.
import { describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { handleCursorChange } from '../../src/resolver/cursor-follow.js';
import type {
    CursorFollowDeps,
    CursorFollowLog,
    CursorFollowSurfaces,
    OnMissBehavior
} from '../../src/resolver/cursor-follow.js';
import type { NavTarget } from '../../src/ui/surface/navigation.js';
import type { SymbolHit } from '../../src/docset/types.js';
import type { Resolver, ResolvedSymbol } from '../../src/resolver/types.js';

function makeDoc(languageId = 'cpp'): vscode.TextDocument {
    return {
        uri: { toString: (): string => 'file:///t.cpp' },
        version: 1,
        languageId,
        getText: () => '',
        lineAt: () => ({ text: '' }),
        lineCount: 0
    } as unknown as vscode.TextDocument;
}

function makePos(line = 0, character = 0): vscode.Position {
    return { line, character } as unknown as vscode.Position;
}

interface Harness {
    deps: CursorFollowDeps;
    resolveResult: { value: ResolvedSymbol | undefined };
    lookupResult: { value: SymbolHit | undefined };
    ensureActiveSurface: ReturnType<typeof vi.fn<() => Promise<void>>>;
    loadPage: ReturnType<typeof vi.fn>;
    historyPush: ReturnType<typeof vi.fn<(target: NavTarget) => void>>;
    notifyNavigated: ReturnType<typeof vi.fn<(target: NavTarget) => void>>;
    renderEmptyPage: ReturnType<typeof vi.fn<() => Promise<void>>>;
    renderMissPlaceholder: ReturnType<typeof vi.fn<(fqn: string) => Promise<void>>>;
    renderNotInstalledPlaceholder: ReturnType<typeof vi.fn<(fqn: string) => Promise<void>>>;
    resolverResolve: ReturnType<typeof vi.fn>;
    lookupExact: ReturnType<typeof vi.fn>;
    lookupBest: ReturnType<typeof vi.fn>;
    followCursor: { value: boolean };
    onMissBehavior: { value: OnMissBehavior };
    hasAnyDocset: { value: boolean };
    state: {
        lastShownSymbolId: number | undefined;
        lastNoDocsetsFqn?: string | undefined;
    };
    webview: vscode.Webview;
}

function makeHarness(): Harness {
    const resolveResult: { value: ResolvedSymbol | undefined } = {
        value: undefined
    };
    const lookupResult: { value: SymbolHit | undefined } = { value: undefined };
    const followCursor = { value: true };
    const onMissBehavior: { value: OnMissBehavior } = { value: 'stay' };
    const hasAnyDocset = { value: true };
    const state: {
        lastShownSymbolId: number | undefined;
        lastNoDocsetsFqn?: string | undefined;
    } = {
        lastShownSymbolId: undefined,
        lastNoDocsetsFqn: undefined
    };

    const resolverResolve = vi.fn(async () => resolveResult.value);
    const resolver: Resolver = {
        strategyOrder: ['clangd', 'hover', 'definition', 'fallback'],
        resolve: resolverResolve as unknown as Resolver['resolve']
    };
    const lookupExact = vi.fn(() => lookupResult.value);
    const lookupBest = vi.fn(() => lookupResult.value);
    const ensureActiveSurface = vi.fn<() => Promise<void>>(async () => { });
    const loadPage = vi.fn(async () => true);
    const historyPush = vi.fn<(target: NavTarget) => void>();
    const notifyNavigated = vi.fn<(target: NavTarget) => void>();
    const renderEmptyPage = vi.fn<() => Promise<void>>(async () => { });
    const renderMissPlaceholder = vi.fn<(fqn: string) => Promise<void>>(
        async (_fqn) => { }
    );
    const renderNotInstalledPlaceholder = vi.fn<(fqn: string) => Promise<void>>(
        async (_fqn) => { }
    );

    const webview = {} as vscode.Webview;
    const surfaces: CursorFollowSurfaces = {
        ensureActiveSurface,
        getActiveWebview: () => webview,
        getActiveHistory: () => ({ push: historyPush }),
        notifyNavigated,
        renderEmptyPage,
        renderMissPlaceholder,
        renderNotInstalledPlaceholder
    };

    const deps: CursorFollowDeps = {
        resolver,
        docsets: {
            lookupExact: lookupExact as unknown as (q: string) => SymbolHit | undefined,
            lookupBest: lookupBest as unknown as (q: string) => SymbolHit | undefined
        },
        surfaces,
        loadPage: loadPage as unknown as CursorFollowDeps['loadPage'],
        followCursor: () => followCursor.value,
        onMissBehavior: () => onMissBehavior.value,
        hasAnyDocset: () => hasAnyDocset.value,
        state
    };

    return {
        deps,
        resolveResult,
        lookupResult,
        ensureActiveSurface,
        loadPage,
        historyPush,
        notifyNavigated,
        renderEmptyPage,
        renderMissPlaceholder,
        renderNotInstalledPlaceholder,
        resolverResolve,
        lookupExact,
        lookupBest,
        followCursor,
        onMissBehavior,
        hasAnyDocset,
        state,
        webview
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

describe('handleCursorChange', () => {
    it('does nothing when followCursor is false', async () => {
        const h = makeHarness();
        h.followCursor.value = false;

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.resolverResolve).not.toHaveBeenCalled();
        expect(h.ensureActiveSurface).not.toHaveBeenCalled();
        expect(h.loadPage).not.toHaveBeenCalled();
    });

    it('does nothing for non-cpp/c documents', async () => {
        const h = makeHarness();

        for (const lang of ['rust', 'plaintext', 'typescript', 'python']) {
            h.resolverResolve.mockClear();
            await handleCursorChange(h.deps, makeDoc(lang), makePos());
            expect(h.resolverResolve).not.toHaveBeenCalled();
        }
    });

    it('runs resolver for cpp documents', async () => {
        const h = makeHarness();
        await handleCursorChange(h.deps, makeDoc('cpp'), makePos());
        expect(h.resolverResolve).toHaveBeenCalledTimes(1);
    });

    it('runs resolver for c documents', async () => {
        const h = makeHarness();
        await handleCursorChange(h.deps, makeDoc('c'), makePos());
        expect(h.resolverResolve).toHaveBeenCalledTimes(1);
    });

    it('on resolver miss: leaves panel unchanged (sticky)', async () => {
        const h = makeHarness();
        h.resolveResult.value = undefined;

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.lookupBest).not.toHaveBeenCalled();
        expect(h.ensureActiveSurface).not.toHaveBeenCalled();
        expect(h.loadPage).not.toHaveBeenCalled();
    });

    it('on hit + lookup succeeds: ensures surface, pushes history, loads page, notifies', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.lookupBest).toHaveBeenCalledWith('std::vector::push_back');
        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        expect(h.historyPush).toHaveBeenCalledWith({
            docsetId: 1,
            pagePath: 'en/cpp/container/vector/push_back.html'
        });
        expect(h.loadPage).toHaveBeenCalledTimes(1);
        expect(h.notifyNavigated).toHaveBeenCalledTimes(1);
        expect(h.state.lastShownSymbolId).toBe(42);
    });

    it('dedup: same hit twice in a row → second invocation skips surface activity', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'std::vector::push_back', source: 'clangd' };
        h.lookupResult.value = makeHit();

        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.loadPage).toHaveBeenCalledTimes(1);
        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);

        await handleCursorChange(h.deps, makeDoc(), makePos());
        // Resolver / lookup ran again (cheap; cache wraps the resolver).
        // But ensureActiveSurface / loadPage MUST NOT fire — that's the
        // "user is reading, don't churn" guarantee.
        expect(h.loadPage).toHaveBeenCalledTimes(1);
        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        expect(h.historyPush).toHaveBeenCalledTimes(1);
    });

    it('different hit advances the page (and updates lastShownSymbolId)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'A' };
        h.lookupResult.value = makeHit({ id: 1, qualifiedName: 'A' });

        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.loadPage).toHaveBeenCalledTimes(1);
        expect(h.state.lastShownSymbolId).toBe(1);

        h.resolveResult.value = { fqn: 'B' };
        h.lookupResult.value = makeHit({ id: 2, qualifiedName: 'B' });
        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.loadPage).toHaveBeenCalledTimes(2);
        expect(h.state.lastShownSymbolId).toBe(2);
    });

    it('on FQN that misses lookup + onMissBehavior=stay: no surface change', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'mystery::sym' };
        h.lookupResult.value = undefined;
        h.onMissBehavior.value = 'stay';

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.lookupBest).toHaveBeenCalledWith('mystery::sym');
        expect(h.ensureActiveSurface).not.toHaveBeenCalled();
        expect(h.loadPage).not.toHaveBeenCalled();
        expect(h.historyPush).not.toHaveBeenCalled();
    });

    // M6.3.B — onMissBehavior wiring.
    it('on FQN miss + onMissBehavior=showLink: ensures surface, renders miss placeholder with the FQN', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'mystery::sym' };
        h.lookupResult.value = undefined;
        h.onMissBehavior.value = 'showLink';

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        expect(h.renderMissPlaceholder).toHaveBeenCalledWith('mystery::sym');
        expect(h.renderEmptyPage).not.toHaveBeenCalled();
        expect(h.loadPage).not.toHaveBeenCalled();
        expect(h.historyPush).not.toHaveBeenCalled();
        expect(h.notifyNavigated).not.toHaveBeenCalled();
    });

    it('on FQN miss + onMissBehavior=clearPanel: ensures surface, renders empty page', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'mystery::sym' };
        h.lookupResult.value = undefined;
        h.onMissBehavior.value = 'clearPanel';

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        expect(h.renderEmptyPage).toHaveBeenCalledTimes(1);
        expect(h.renderMissPlaceholder).not.toHaveBeenCalled();
        expect(h.loadPage).not.toHaveBeenCalled();
        expect(h.historyPush).not.toHaveBeenCalled();
    });

    it('after a miss-clear, the next real hit (same id as before) re-renders (lastShownSymbolId is reset)', async () => {
        const h = makeHarness();
        // First, a successful hit lands and sets lastShownSymbolId=42.
        h.resolveResult.value = { fqn: 'std::vector::push_back' };
        h.lookupResult.value = makeHit({ id: 42 });
        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.loadPage).toHaveBeenCalledTimes(1);

        // Then, a clearPanel miss wipes the surface and resets dedup.
        h.resolveResult.value = { fqn: 'gone' };
        h.lookupResult.value = undefined;
        h.onMissBehavior.value = 'clearPanel';
        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.renderEmptyPage).toHaveBeenCalledTimes(1);

        // Same symbol comes back — must re-render, not silently dedup.
        h.resolveResult.value = { fqn: 'std::vector::push_back' };
        h.lookupResult.value = makeHit({ id: 42 });
        await handleCursorChange(h.deps, makeDoc(), makePos());
        expect(h.loadPage).toHaveBeenCalledTimes(2);
    });

    it('aborts cleanly when there is no active surface (webview undefined after ensure)', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'X' };
        h.lookupResult.value = makeHit();
        // Override surfaces so the active webview is unavailable post-ensure.
        h.deps.surfaces = {
            ensureActiveSurface: h.ensureActiveSurface,
            getActiveWebview: () => undefined,
            getActiveHistory: () => undefined,
            notifyNavigated: h.notifyNavigated,
            renderEmptyPage: h.renderEmptyPage,
            renderMissPlaceholder: h.renderMissPlaceholder,
            renderNotInstalledPlaceholder: h.renderNotInstalledPlaceholder
        };

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        expect(h.loadPage).not.toHaveBeenCalled();
        expect(h.historyPush).not.toHaveBeenCalled();
        expect(h.notifyNavigated).not.toHaveBeenCalled();
    });

    it('does not call notifyNavigated when loadPage returns false', async () => {
        const h = makeHarness();
        h.resolveResult.value = { fqn: 'X' };
        h.lookupResult.value = makeHit();
        h.loadPage.mockImplementation(async () => false);

        await handleCursorChange(h.deps, makeDoc(), makePos());

        expect(h.loadPage).toHaveBeenCalledTimes(1);
        expect(h.notifyNavigated).not.toHaveBeenCalled();
    });

    // Fix C — "FQN found but ZERO docsets installed" branch.
    // Fix B (iter 37) — diagnostic log injection. `handleCursorChange`
    // now emits a structured event for every decision point so users can
    // open the C++ Docs output channel and see what's happening. Tests
    // here pin the event names to the ones documented in the prompt;
    // changing them is fine, but renaming the event-name string is a
    // user-visible change so we make it explicit by failing the contract.
    describe('Fix B — diagnostic logging', () => {
        function logSpy(): {
            log: CursorFollowLog & ReturnType<typeof vi.fn<CursorFollowLog>>;
            events: () => Array<[string, Record<string, unknown> | undefined]>;
        } {
            const log = vi.fn<CursorFollowLog>();
            return {
                log,
                events: () =>
                    log.mock.calls.map(
                        (c) =>
                            [c[0], c[1]] as [string, Record<string, unknown> | undefined]
                    )
            };
        }

        it('emits cursor.skip.disabled when followCursor is off', async () => {
            const h = makeHarness();
            h.followCursor.value = false;
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(spy.events()).toEqual([['cursor.skip.disabled', undefined]]);
        });

        it('emits cursor.skip.lang with the languageId for non-cpp/c documents', async () => {
            const h = makeHarness();
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc('rust'), makePos());
            expect(spy.events()).toEqual([['cursor.skip.lang', { lang: 'rust' }]]);
        });

        it('emits cursor.resolve.miss when the resolver returns undefined', async () => {
            const h = makeHarness();
            h.resolveResult.value = undefined;
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(spy.events()).toEqual([['cursor.resolve.miss', undefined]]);
        });

        it('emits cursor.resolve.hit + cursor.lookup.miss + behavior on lookup miss', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'mystery::sym', source: 'fallback' };
            h.lookupResult.value = undefined;
            h.onMissBehavior.value = 'stay';
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(spy.events()).toEqual([
                ['cursor.resolve.hit', { fqn: 'mystery::sym', source: 'fallback' }],
                ['cursor.lookup.miss', { fqn: 'mystery::sym', behavior: 'stay' }]
            ]);
        });

        it('emits cursor.lookup.miss.no-docsets when zero docsets are installed', async () => {
            const h = makeHarness();
            h.hasAnyDocset.value = false;
            h.resolveResult.value = { fqn: 'std::vector::push_back' };
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc(), makePos());
            const events = spy.events();
            // Resolver hit logged first, then the no-docsets miss.
            expect(events[0]?.[0]).toBe('cursor.resolve.hit');
            expect(events[1]).toEqual([
                'cursor.lookup.miss.no-docsets',
                { fqn: 'std::vector::push_back' }
            ]);
        });

        it('emits cursor.lookup.hit.dedup on the second of two identical hits', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'std::vector::push_back' };
            h.lookupResult.value = makeHit();
            const spy = logSpy();
            h.deps.log = spy.log;

            await handleCursorChange(h.deps, makeDoc(), makePos());
            await handleCursorChange(h.deps, makeDoc(), makePos());
            const dedupCall = spy
                .events()
                .find((e) => e[0] === 'cursor.lookup.hit.dedup');
            expect(dedupCall).toBeDefined();
            expect(dedupCall?.[1]).toMatchObject({
                fqn: 'std::vector::push_back',
                symbolId: 42
            });
        });

        it('emits cursor.lookup.hit.load on the loadPage call (success path)', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'std::vector::push_back' };
            h.lookupResult.value = makeHit();
            const spy = logSpy();
            h.deps.log = spy.log;
            await handleCursorChange(h.deps, makeDoc(), makePos());
            const loadCall = spy
                .events()
                .find((e) => e[0] === 'cursor.lookup.hit.load');
            expect(loadCall).toBeDefined();
            expect(loadCall?.[1]).toMatchObject({
                fqn: 'std::vector::push_back',
                pagePath: 'en/cpp/container/vector/push_back.html',
                ok: true
            });
        });

        it('omitting log: handler runs identically (the field is optional)', async () => {
            const h = makeHarness();
            h.resolveResult.value = { fqn: 'X' };
            h.lookupResult.value = makeHit();
            // No `log` injected — must not throw.
            await expect(
                handleCursorChange(h.deps, makeDoc(), makePos())
            ).resolves.toBeUndefined();
            expect(h.loadPage).toHaveBeenCalledTimes(1);
        });
    });

    describe('hasAnyDocset=false (Fix C)', () => {
        it('renders the not-installed placeholder when the resolver hits and zero docsets exist (regardless of onMissBehavior)', async () => {
            const h = makeHarness();
            h.hasAnyDocset.value = false;
            // `stay` would normally swallow this silently — Fix C must
            // override and surface the install link anyway.
            h.onMissBehavior.value = 'stay';
            h.resolveResult.value = { fqn: 'std::vector::push_back' };
            // lookupExact is irrelevant in this branch — assert it's never
            // called so we know the override fires before that lookup.

            await handleCursorChange(h.deps, makeDoc(), makePos());

            expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
            expect(h.renderNotInstalledPlaceholder).toHaveBeenCalledWith(
                'std::vector::push_back'
            );
            expect(h.lookupBest).not.toHaveBeenCalled();
            expect(h.renderMissPlaceholder).not.toHaveBeenCalled();
            expect(h.renderEmptyPage).not.toHaveBeenCalled();
            expect(h.loadPage).not.toHaveBeenCalled();
            // lastShownSymbolId reset so a future install + same-symbol
            // lookup re-renders rather than silently dedup.
            expect(h.state.lastShownSymbolId).toBeUndefined();
            expect(h.state.lastNoDocsetsFqn).toBe('std::vector::push_back');
        });

        it('dedups the not-installed placeholder when the same FQN repeats', async () => {
            const h = makeHarness();
            h.hasAnyDocset.value = false;
            h.resolveResult.value = { fqn: 'std::vector::push_back' };

            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.renderNotInstalledPlaceholder).toHaveBeenCalledTimes(1);

            // Same FQN → no second placeholder render.
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.renderNotInstalledPlaceholder).toHaveBeenCalledTimes(1);
            expect(h.ensureActiveSurface).toHaveBeenCalledTimes(1);
        });

        it('different FQN re-renders the not-installed placeholder (dedup is per-FQN)', async () => {
            const h = makeHarness();
            h.hasAnyDocset.value = false;
            h.resolveResult.value = { fqn: 'A' };
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.renderNotInstalledPlaceholder).toHaveBeenCalledTimes(1);

            h.resolveResult.value = { fqn: 'B' };
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.renderNotInstalledPlaceholder).toHaveBeenCalledTimes(2);
            expect(h.state.lastNoDocsetsFqn).toBe('B');
        });

        it('clears lastNoDocsetsFqn once a docset becomes available', async () => {
            const h = makeHarness();
            // First, no docsets — placeholder fires and stamps the dedup.
            h.hasAnyDocset.value = false;
            h.resolveResult.value = { fqn: 'std::vector::push_back' };
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.state.lastNoDocsetsFqn).toBe('std::vector::push_back');

            // Install lands; the resolver hits the same name and the
            // dedup gets reset so a future removal re-arms.
            h.hasAnyDocset.value = true;
            h.lookupResult.value = makeHit();
            await handleCursorChange(h.deps, makeDoc(), makePos());
            expect(h.state.lastNoDocsetsFqn).toBeUndefined();
            expect(h.loadPage).toHaveBeenCalledTimes(1);
        });
    });
});
