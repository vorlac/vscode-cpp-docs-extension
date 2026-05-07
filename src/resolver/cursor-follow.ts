// Cursor-follow handler.
//
// Per docs/03-symbol-resolution.md § "Cursor-follow semantics":
//   1. Bail if `cppDocs.panel.followCursor` is false.
//   2. Bail if the document languageId is not `cpp` / `c`.
//   3. Resolve the FQN at the cursor.
//   4. Sticky on miss: leave the panel as-is (no clear, no re-render).
//   5. On hit, look up the docset page via `lookupExact`. If the FQN
//      is real but no installed docset has the page, branch on
//      `cppDocs.panel.onMissBehavior`:
//         - `stay`        — leave the panel unchanged (default)
//         - `showLink`    — TODO M6: render a placeholder card
//         - `clearPanel`  — TODO M6: clear the panel
//   6. Dedup: if the FQN resolves to the same symbol that's currently
//      shown, skip the surface activity entirely (the user is just
//      reading; no need to thrash the page).
//   7. Otherwise, ensure an active surface exists, push the target
//      onto its history, and load the page.
//
// `extension.ts` debounces the wrapper and pushes that subscription
// onto its disposable list. This module is a pure-ish handler: every
// vscode and surface dependency is injected so it's directly testable.
import type * as vscode from 'vscode';
import type { DocsetManager } from '../docset/manager.js';
import type { SymbolHit } from '../docset/types.js';
import type { NavTarget } from '../ui/surface/navigation.js';
import type { Resolver } from './types.js';

export type OnMissBehavior = 'stay' | 'showLink' | 'clearPanel';

/**
 * Surfaces accessor surface. The cursor-follow handler doesn't touch
 * SurfaceManager directly — instead, it pulls the active webview /
 * history at the moment of update so any surface arbitration changes
 * between debounce-schedule and debounce-fire are respected.
 */
export interface CursorFollowSurfaces {
    ensureActiveSurface(): Promise<void>;
    getActiveWebview(): vscode.Webview | undefined;
    getActiveHistory():
        | { push(target: NavTarget): void }
        | undefined;
    notifyNavigated(target: NavTarget): void;
    /**
     * Render an empty page on the active surface. Used by the
     * `clearPanel` onMissBehavior. The page carries the standard
     * attribution block but no content; the previous page is gone.
     */
    renderEmptyPage(): Promise<void>;
    /**
     * Render a "no docs page for `<fqn>`" placeholder on the active
     * surface, with a link that fires `cppDocs.openSymbol` pre-filled
     * with the FQN. Used by the `showLink` onMissBehavior.
     */
    renderMissPlaceholder(fqn: string): Promise<void>;
    /**
     * Render a "C++ Docs not installed" placeholder on the active
     * surface, with a single link that fires
     * `cppDocs.installCppreference`. Used when the resolver returns an
     * FQN but zero docsets are installed — structurally distinct from
     * `renderMissPlaceholder` (FQN found but no page in any installed
     * docset), and the user-visible message is different ("install"
     * vs. "search").
     */
    renderNotInstalledPlaceholder(fqn: string): Promise<void>;
}

/**
 * Diagnostic logger. Defaults to a no-op so existing tests that omit
 * the field stay green; production wiring in `extension.ts` injects
 * `logEvent` from `src/util/output.ts` so every cursor-follow decision
 * is visible in the C++ Docs output channel.
 *
 * Fix B (iter 37) — the prior silence on every miss/skip path made the
 * resolver feel broken even when it was working: the user couldn't
 * tell whether the resolver fired, what FQN it produced, or whether
 * `lookupExact` hit. Each event below is one log line.
 */
export type CursorFollowLog = (
    event: string,
    fields?: Record<string, unknown>
) => void;

/**
 * Dependencies for `handleCursorChange`. All vscode and surface
 * touchpoints are injected so the handler unit-tests against pure
 * mocks.
 */
export interface CursorFollowDeps {
    resolver: Resolver;
    docsets: Pick<DocsetManager, 'lookupExact' | 'lookupBest'>;
    surfaces: CursorFollowSurfaces;
    /**
     * Render `target` into `webview`. Mirrors `loadPageInWebview`'s
     * signature; injected so the handler doesn't need a vscode `Uri`.
     */
    loadPage(
        webview: vscode.Webview,
        target: NavTarget
    ): Promise<boolean>;
    /** Reads `cppDocs.panel.followCursor`. */
    followCursor: () => boolean;
    /** Reads `cppDocs.panel.onMissBehavior`. */
    onMissBehavior: () => OnMissBehavior;
    /**
     * Returns true when at least one docset is installed. Used by Fix C
     * to render the "not installed" placeholder regardless of
     * `onMissBehavior`: a `stay` configuration combined with zero
     * docsets would otherwise silently swallow every cursor move.
     */
    hasAnyDocset: () => boolean;
    /**
     * Track of the last shown symbol's id for dedup, plus the last FQN
     * we surfaced through the not-installed placeholder so the surface
     * doesn't thrash as the cursor moves over the same name.
     */
    state: {
        lastShownSymbolId: number | undefined;
        lastNoDocsetsFqn?: string | undefined;
    };
    /**
     * Optional structured logger. Production wires
     * `logEvent` from `src/util/output.ts`; tests may inject a spy or
     * omit it entirely (events fall through to a no-op). See
     * `CursorFollowLog` for the rationale.
     */
    log?: CursorFollowLog;
}

/**
 * Process a single cursor change. Idempotent and safe to call
 * concurrently; if two events fire at the same position the second's
 * dedup short-circuits.
 *
 * Returns void — surface mutations are side effects through the
 * injected surfaces / loadPage handles.
 */
export async function handleCursorChange(
    deps: CursorFollowDeps,
    document: vscode.TextDocument,
    position: vscode.Position
): Promise<void> {
    const log = deps.log ?? noopLog;

    if (!deps.followCursor()) {
        log('cursor.skip.disabled');
        return;
    }

    const lang = document.languageId;
    // L-5 — extend the allowlist so users editing C-family superset
    // languages (Objective-C, Objective-C++, CUDA C++) still get the
    // cursor-follow / hover behavior.
    if (
        lang !== 'cpp' &&
        lang !== 'c' &&
        lang !== 'cuda-cpp' &&
        lang !== 'objective-c' &&
        lang !== 'objective-cpp'
    ) {
        log('cursor.skip.lang', { lang });
        return;
    }

    const resolved = await deps.resolver.resolve(document, position);
    if (!resolved) {
        log('cursor.resolve.miss');
        return; // sticky: leave panel as-is
    }
    log('cursor.resolve.hit', { fqn: resolved.fqn, source: resolved.source });

    // Fix C — "no docsets installed" is structurally different from
    // "FQN doesn't exist in installed docsets". The configured
    // `onMissBehavior` (especially `stay`) silently swallows the empty
    // case otherwise; the user has no idea why nothing's happening as
    // they move the cursor. Override and render the install placeholder
    // ONCE per unique FQN per session so we don't thrash the surface
    // while the cursor parks on the same name.
    if (!deps.hasAnyDocset()) {
        log('cursor.lookup.miss.no-docsets', { fqn: resolved.fqn });
        if (deps.state.lastNoDocsetsFqn !== resolved.fqn) {
            deps.state.lastNoDocsetsFqn = resolved.fqn;
            await deps.surfaces.ensureActiveSurface();
            await deps.surfaces.renderNotInstalledPlaceholder(resolved.fqn);
            // Reset symbol-dedup so once a docset gets installed, the next
            // real hit on this symbol still re-renders.
            deps.state.lastShownSymbolId = undefined;
        }
        return;
    }
    // A docset exists again — clear the not-installed dedup so removal
    // → install → removal cycles re-prompt cleanly.
    deps.state.lastNoDocsetsFqn = undefined;

    const hit: SymbolHit | undefined = deps.docsets.lookupBest(resolved.fqn);
    if (!hit) {
        const behavior = deps.onMissBehavior();
        log('cursor.lookup.miss', { fqn: resolved.fqn, behavior });
        if (behavior === 'showLink') {
            await deps.surfaces.ensureActiveSurface();
            await deps.surfaces.renderMissPlaceholder(resolved.fqn);
            // Reset dedup so the next *real* hit on the same symbol still
            // re-renders (we just clobbered the page).
            deps.state.lastShownSymbolId = undefined;
            return;
        }
        if (behavior === 'clearPanel') {
            await deps.surfaces.ensureActiveSurface();
            await deps.surfaces.renderEmptyPage();
            deps.state.lastShownSymbolId = undefined;
            return;
        }
        // 'stay' (default): no-op.
        return;
    }

    if (hit.id === deps.state.lastShownSymbolId) {
        log('cursor.lookup.hit.dedup', { fqn: resolved.fqn, symbolId: hit.id });
        return;
    }
    deps.state.lastShownSymbolId = hit.id;

    await deps.surfaces.ensureActiveSurface();
    const webview = deps.surfaces.getActiveWebview();
    const history = deps.surfaces.getActiveHistory();
    if (!webview || !history) {
        log('cursor.lookup.hit.no-surface', {
            fqn: resolved.fqn,
            symbolId: hit.id
        });
        return;
    }

    const target: NavTarget = {
        docsetId: hit.docsetId,
        pagePath: hit.filePath
    };
    const ok = await deps.loadPage(webview, target);
    log('cursor.lookup.hit.load', {
        fqn: resolved.fqn,
        pagePath: hit.filePath,
        ok
    });
    if (ok) {
        history.push(target);
        deps.surfaces.notifyNavigated(target);
    }
}

const noopLog: CursorFollowLog = () => { };
