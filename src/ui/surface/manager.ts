import type * as vscode from 'vscode';
import type { NavigationHistory, NavTarget } from './navigation.js';

/**
 * Where the single C++ Docs surface lives. Persisted in globalState
 * across restarts so the doc panel always restores to the slot the
 * user last placed it in (and to `'sidebar'` on a fresh install).
 *
 * Single-instance is enforced at the command layer: moving from
 * sidebar to editor disposes any open panel and then creates a fresh
 * one prepopulated with the view's history; moving the other way
 * disposes the panel and focuses the (still-registered) sidebar view.
 * The `when` clause on the view contribution in `package.json` keys
 * off the `cppDocs.location === 'sidebar'` setContext, so the
 * sidebar entry vanishes from the activity bar / panel area when
 * `location === 'editor'` and reappears on toggle.
 */
export type DocPanelLocation = 'sidebar' | 'editor';

export type SurfaceTarget = 'view' | 'panel';

/**
 * Listener disposable returned by `SurfaceManager.onDidNavigate`. Mirrors
 * VSCode's `Disposable` contract without dragging the `vscode` import into
 * SurfaceManager (kept structurally testable).
 */
export interface NavigationListenerDisposable {
    dispose(): void;
}

export type NavigationListener = (target: NavTarget) => void;

/**
 * Tracks the single C++ Docs surface — either a `WebviewView` (sidebar
 * / aux panel) OR a `WebviewPanel` (editor tab), never both. Single-
 * instance is a user-facing invariant per the move-to-editor /
 * dock-in-sidebar commands: each move atomically disposes the source
 * surface before attaching the destination.
 *
 * `pickTarget()` collapses to "whichever surface is currently
 * attached" — the historic auto-arbitration between two visible
 * surfaces is gone because two attached surfaces can no longer exist
 * at the same time.
 *
 * Storing full vscode types makes this class load-bearing for the
 * surface lifecycle; the rest of the API only reads `.visible`, so
 * unit tests work against structural mocks.
 */
export class SurfaceManager {
    private view: vscode.WebviewView | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private viewHistory: NavigationHistory | undefined;
    private panelHistory: NavigationHistory | undefined;
    /**
     * Set of docset ids whose `documentsDir` was included in the view /
     * panel's `localResourceRoots` at resolve / create time. Used by C-2
     * to detect a docset-set drift (install / import / remove after the
     * surface was already attached) and surface the reload-required
     * placeholder.
     */
    private viewResourceDocsetIds: Set<number> = new Set();
    private panelResourceDocsetIds: Set<number> = new Set();
    private navListeners: NavigationListener[] = [];

    constructor() { }

    /**
     * Subscribe to post-render navigation events. Fired by `notifyNavigated`
     * after every successful `loadPageInWebview`, regardless of which surface
     * (view or panel) initiated the load. Used by `extension.ts` to drive
     * `treeView.reveal()` so the tree stays in sync with the active page
     * (docs/02-architecture.md §"Resolver wiring").
     */
    onDidNavigate(listener: NavigationListener): NavigationListenerDisposable {
        this.navListeners.push(listener);
        return {
            dispose: () => {
                this.navListeners = this.navListeners.filter((l) => l !== listener);
            }
        };
    }

    /**
     * Fire the `onDidNavigate` event. Call sites: every path that successfully
     * renders a page into a surface — QuickPick, tree-click, history back/
     * forward, in-page link interception, panel rehydration. Round-tripping
     * (e.g. tree-click → reveal → no-op because already-selected) is
     * idempotent and explicitly safe.
     */
    notifyNavigated(target: NavTarget): void {
        for (const l of this.navListeners) l(target);
    }

    attachView(
        view: vscode.WebviewView,
        history?: NavigationHistory,
        docsetIds?: readonly number[]
    ): void {
        this.view = view;
        this.viewHistory = history;
        this.viewResourceDocsetIds = new Set(docsetIds ?? []);
    }

    /**
     * Detach the WebviewView. We deliberately retain `viewHistory` so the
     * provider can hand the same history back to a future `attachView`
     * call after a `retainContextWhenHidden: false` re-resolve (Fix A —
     * iter 37). Without this, every sidebar collapse / tab switch
     * clobbers the active NavTarget and the next cursor-follow update
     * lands on a fresh, empty view.
     */
    detachView(): void {
        this.view = undefined;
    }

    attachPanel(
        panel: vscode.WebviewPanel,
        history?: NavigationHistory,
        docsetIds?: readonly number[]
    ): void {
        this.panel = panel;
        this.panelHistory = history;
        this.panelResourceDocsetIds = new Set(docsetIds ?? []);
    }

    /**
     * Detach the WebviewPanel. As with `detachView`, the panel's history
     * is intentionally retained so a future re-resolve (the in-session
     * "panel got hidden then re-shown" path) can pick up where the user
     * left off rather than starting fresh.
     */
    detachPanel(): void {
        this.panel = undefined;
    }

    /**
     * Transfer the editor-tab panel's `NavigationHistory` over to the
     * view side before disposing the panel during a "dock in sidebar"
     * move. After this call the view's next `attachView` will reuse the
     * just-promoted history so the user lands on the same page in the
     * sidebar as they were viewing in the editor tab. Mirror exists
     * (`adoptViewHistoryToPanel`) for the reverse direction.
     */
    adoptPanelHistoryToView(): void {
        if (this.panelHistory) this.viewHistory = this.panelHistory;
    }

    adoptViewHistoryToPanel(): void {
        if (this.viewHistory) this.panelHistory = this.viewHistory;
    }

    hasView(): boolean {
        return this.view !== undefined;
    }

    hasPanel(): boolean {
        return this.panel !== undefined;
    }

    getView(): vscode.WebviewView | undefined {
        return this.view;
    }

    getPanel(): vscode.WebviewPanel | undefined {
        return this.panel;
    }

    getActiveHistory(): NavigationHistory | undefined {
        const target = this.pickTarget();
        if (target === 'view') return this.viewHistory;
        if (target === 'panel') return this.panelHistory;
        return undefined;
    }

    /**
     * Fix A — getters used by `resolveWebviewView` / `createOrRevealPanel`
     * to restore a surface's prior page when VSCode tears it down and
     * re-resolves it (sidebar collapse, tab switch, focus transition with
     * `retainContextWhenHidden: false`). The provider hands us back the
     * existing history so navigation continuity survives the visibility
     * flip; without this, every re-resolve clobbers the page with a
     * placeholder and the cursor-follow update from the same flip lands
     * on a fresh, empty view.
     *
     * Returns `undefined` when no history has been attached yet (first
     * resolve in this session, or post-detach).
     */
    getViewHistory(): NavigationHistory | undefined {
        return this.viewHistory;
    }

    getPanelHistory(): NavigationHistory | undefined {
        return this.panelHistory;
    }

    getActiveWebview(): vscode.Webview | undefined {
        const target = this.pickTarget();
        if (target === 'view') return this.view?.webview;
        if (target === 'panel') return this.panel?.webview;
        return undefined;
    }

    /**
     * C-2 — return true when the surface's `localResourceRoots` no longer
     * cover the given docset id. Used by the install / import / remove
     * paths to decide whether to show the reload-required placeholder.
     */
    viewNeedsRefreshFor(docsetId: number): boolean {
        if (!this.view) return false;
        return !this.viewResourceDocsetIds.has(docsetId);
    }

    panelNeedsRefreshFor(docsetId: number): boolean {
        if (!this.panel) return false;
        return !this.panelResourceDocsetIds.has(docsetId);
    }

    /**
     * C-2 — true if the view's resource roots are stale relative to the
     * supplied "currently installed docset ids" set. Stale = at least one
     * installed docset is not in our resource-root snapshot.
     */
    viewIsStale(currentDocsetIds: readonly number[]): boolean {
        if (!this.view) return false;
        const current = new Set(currentDocsetIds);
        for (const id of current) {
            if (!this.viewResourceDocsetIds.has(id)) return true;
        }
        for (const id of this.viewResourceDocsetIds) {
            if (!current.has(id)) return true;
        }
        return false;
    }

    panelIsStale(currentDocsetIds: readonly number[]): boolean {
        if (!this.panel) return false;
        const current = new Set(currentDocsetIds);
        for (const id of current) {
            if (!this.panelResourceDocsetIds.has(id)) return true;
        }
        for (const id of this.panelResourceDocsetIds) {
            if (!current.has(id)) return true;
        }
        return false;
    }

    /**
     * Return whichever surface is attached. The single-instance
     * invariant means at most one of `view` / `panel` is ever defined
     * at a time, so the historic two-visible arbitration path is gone.
     */
    pickTarget(): SurfaceTarget | undefined {
        if (this.view) return 'view';
        if (this.panel) return 'panel';
        return undefined;
    }
}
