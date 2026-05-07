import * as path from 'node:path';
import * as vscode from 'vscode';
import { DocsetManager } from './docset/manager.js';
import type { SymbolHit } from './docset/types.js';
import { evaluateUpdate } from './docset/update-check.js';
import { INDEXER_VERSION, INDEXER_VERSION_KEY } from './docset/cppreference-indexer.js';
import {
    buildProductionResolver,
    handleCursorChange,
    type CursorFollowSurfaces,
    type OnMissBehavior
} from './resolver/index.js';
import { CppStandardManager } from './ui/cpp-standard-manager.js';
import {
    SELECTABLE_STANDARDS,
    tokenToSetting
} from './ui/cpp-standard.js';
import { CppDocsHoverProvider } from './ui/hover-provider.js';
import {
    SurfaceManager,
    type DocPanelLocation
} from './ui/surface/manager.js';
import {
    loadPageInWebview,
    renderEmptyPage,
    renderMissPlaceholder,
    renderNotInstalledPlaceholder,
    renderReloadPlaceholder,
    type PageLoaderDeps
} from './ui/surface/page-loader.js';
import { DocPanelSerializer } from './ui/surface/serializer.js';
import {
    DocPanelViewProvider,
    VIEW_ID as DOC_PANEL_VIEW_ID
} from './ui/surface/webview-view.js';
import {
    createOrRevealPanel,
    PANEL_VIEW_TYPE,
    type PanelDeps
} from './ui/surface/webview-panel.js';
import {
    CppDocsTreeProvider,
    OPEN_SYMBOL_FROM_TREE_COMMAND,
    OPEN_PAGE_FROM_SEARCH_COMMAND,
    type DocNode
} from './ui/tree-provider.js';
import { SearchViewController, SEARCH_VIEW_ID } from './ui/surface/search-view.js';
import { refreshWelcomeState, type WelcomeStateDeps } from './ui/welcome-state.js';
import { debounce } from './util/debounce.js';
import { getOutputChannel, logEvent } from './util/output.js';
import {
    buildCodeThemeCssVars,
    getCodeTheme
} from './webview-host/code-themes.js';
import type { HostToClientMessage } from './webview-host/messages.js';

let docsets: DocsetManager | undefined;
let surfaces: SurfaceManager | undefined;
let cppStandard: CppStandardManager | undefined;
let statusItem: vscode.StatusBarItem | undefined;
let welcomeDeps: WelcomeStateDeps | undefined;
let treeProvider: CppDocsTreeProvider | undefined;
// Module-scoped so treeView.reveal() can be called when the panel navigates.
let treeView: vscode.TreeView<DocNode> | undefined;
// Holds a node that should be revealed once the tree becomes visible. We
// queue rather than reveal-immediately so navigation doesn't yank the tree
// tab to the foreground and hide the docs panel the user is reading.
let pendingTreeReveal: DocNode | undefined;
// Set to the upstream tag name when the activation-time update check
// finds a newer cppreference release. `refreshStatusItem` reads this to
// switch the status-bar item into "update available" mode without
// re-running the network probe on every refresh.
let updateAvailableVersion: string | undefined;

// Module-scoped per-process install nudge dedup. The previous globalState-keyed
// dedup persisted across dev-host launches, so once the user dismissed (or any
// transient bug suppressed) the nudge they never saw it again. A module-scoped
// flag re-arms on every fresh activation, which matches the user's mental model:
// "if I relaunch and there are still no docsets, ask me again".
let installPromptShownThisSession = false;

async function refreshHasDocsets(): Promise<void> {
    if (!docsets || !welcomeDeps) return;
    await refreshWelcomeState(welcomeDeps);
    refreshStatusItem();
    treeProvider?.refresh();
}

/**
 * C-2 — surface a "Reload Window" placeholder on any active webview
 * whose `localResourceRoots` were locked in before the current docset
 * set existed. Called after install / import / remove succeeds so the
 * user discovers the refresh requirement immediately rather than
 * silently rendering a styles-less page on the next click.
 *
 * For the editor-tab `WebviewPanel` we can `dispose()` it directly —
 * the next reveal will re-create it with the up-to-date roots. For the
 * `WebviewView` (sidebar / aux panel) VSCode doesn't expose `dispose()`
 * publicly, so we render an interstitial that links to
 * `workbench.action.reloadWindow`.
 */
function refreshSurfacesAfterDocsetChange(
    context: vscode.ExtensionContext
): void {
    if (!surfaces || !docsets) return;
    const installed = docsets.listDocsets().map((d) => d.id);
    // Editor-tab panel: cheaper to dispose-and-recreate-on-demand.
    if (surfaces.panelIsStale(installed)) {
        const panel = surfaces.getPanel();
        panel?.dispose();
    }
    // Sidebar/aux view: needs a window reload to pick up new roots.
    if (surfaces.viewIsStale(installed)) {
        const view = surfaces.getView();
        if (view) {
            const bootstrapUri = vscode.Uri.joinPath(
                context.extensionUri,
                'dist',
                'client',
                'bootstrap.js'
            );
            renderReloadPlaceholder(view.webview, bootstrapUri, {
                docsets: docsets,
                cppStandard: cppStandard!,
                attributionEnabled: readAttributionEnabled,
                respectVSCodeTheme: readRespectVSCodeTheme
            });
        }
    }
}

function refreshStatusItem(): void {
    if (!docsets || !statusItem) return;
    const installed = docsets.listDocsets();
    if (installed.length === 0) {
        // Empty-docsets state: switch to the warning icon variant so the
        // bar entry is visually distinguishable from the populated
        // `$(book)` state. Same command as before; the user clicks once
        // to install.
        statusItem.text = '$(warning) C++ Docs: not installed';
        statusItem.tooltip = 'Run "C++ Docs: Install cppreference" to download';
        statusItem.command = 'cppDocs.installCppreference';
    } else if (updateAvailableVersion) {
        // Route the status item to the install command so the user can
        // accept the update with a single click. Tooltip carries the new
        // version explicitly.
        statusItem.text = '$(cloud-download) C++ Docs: update available';
        statusItem.tooltip = `cppreference ${updateAvailableVersion} is available — click to install`;
        statusItem.command = 'cppDocs.installCppreference';
    } else {
        statusItem.text = '$(book) C++';
        statusItem.tooltip = 'Toggles the C++ Documentation Viewer panel visibility';
        statusItem.command = 'cppDocs.toggleDocPanel';
    }
    statusItem.show();
}

function withProgress<T>(
    title: string,
    task: (report: (msg: string) => void) => Promise<T>
): Thenable<T> {
    return vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: false },
        async (progress) => task((msg) => progress.report({ message: msg }))
    );
}

const DOC_PANEL_LOCATION_STATE_KEY = 'cppDocs.docPanel.location';
const DOC_PANEL_LOCATION_CONTEXT_KEY = 'cppDocs.location';

/**
 * Read the persisted documentation-panel location. Defaults to
 * `'sidebar'` for fresh installs. Persisted in `globalState` so the
 * user's preferred slot survives window reloads and VSCode restarts.
 *
 * Single-instance is enforced at the command layer — see
 * `cppDocs.moveToEditorTab` / `cppDocs.dockInSidebar` — so this value
 * always reflects the surface that's currently allowed to attach.
 */
function readDocPanelLocation(
    context: vscode.ExtensionContext
): DocPanelLocation {
    const v = context.globalState.get<string>(DOC_PANEL_LOCATION_STATE_KEY);
    return v === 'editor' ? 'editor' : 'sidebar';
}

async function writeDocPanelLocation(
    context: vscode.ExtensionContext,
    next: DocPanelLocation
): Promise<void> {
    await context.globalState.update(DOC_PANEL_LOCATION_STATE_KEY, next);
    await vscode.commands.executeCommand(
        'setContext',
        DOC_PANEL_LOCATION_CONTEXT_KEY,
        next
    );
}

function cfg<T>(key: string): T | undefined {
    return vscode.workspace.getConfiguration('cppDocs').get<T>(key);
}

function readAttributionEnabled(): boolean { return cfg<boolean>('attribution.enabled') ?? true; }
function readRevealPanelOnSelection(): boolean { return cfg<boolean>('tree.revealPanelOnSelection') ?? true; }
function readRespectVSCodeTheme(): boolean { return cfg<boolean>('theme.respectVSCodeTheme') ?? true; }

function readZoomLevel(): number {
    const raw = cfg<number>('panel.zoomLevel') ?? 1.0;
    return Math.min(3.0, Math.max(0.5, raw));
}

function readCodeTheme(): string | undefined {
    const raw = cfg<string>('codeTheme');
    // Unknown ids (typos, stale defaults from removed themes) fall back
    // to the registry default inside `getCodeTheme` — passing the raw
    // value through is safe.
    return raw && raw.length > 0 ? raw : undefined;
}

/**
 * Resolve the floating-control visibility settings. Each defaults to
 * `true`. Plumbed through the bootstrap payload so the webview-client
 * can skip injecting controls the user has hidden via
 * `cppDocs.controls.*`.
 */
function readControlVisibility(): {
    showZoom: boolean;
    showThemePicker: boolean;
    showNavButtons: boolean;
} {
    return {
        showZoom: cfg<boolean>('controls.showZoom') ?? true,
        showThemePicker: cfg<boolean>('controls.showThemePicker') ?? true,
        showNavButtons: cfg<boolean>('controls.showNavButtons') ?? true
    };
}

function readPinnedVersion(): string { return cfg<string>('cppreference.version') ?? 'latest'; }
function readCheckForUpdatesEnabled(): boolean { return cfg<boolean>('cppreference.checkForUpdates') ?? true; }

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    logEvent('activate.start', {
        dev: context.extensionMode === vscode.ExtensionMode.Development,
        extensionPath: context.extensionUri.fsPath
    });
    await vscode.commands.executeCommand('setContext', 'cppDocs.treeFilterActive', false);
    await vscode.commands.executeCommand('setContext', 'cppDocs.hasDocsets', false);
    const overrideRoot = vscode.workspace.getConfiguration('cppDocs').get<string>('docsetsRoot');
    const storageDir = overrideRoot?.trim()
        ? overrideRoot.trim()
        : path.join(context.globalStorageUri.fsPath, 'docsets');
    docsets = new DocsetManager({ storageDir, log: logEvent });
    // Defensive: a native-binding failure (e.g. better-sqlite3 ABI mismatch
    // after the user runs `npm test` between dev-host launches) would
    // otherwise reject the whole `activate()` Promise silently — every
    // command would no-op with no surfaced reason. Catch and tell the user
    // exactly which knob to turn.
    try {
        await docsets.open();
    } catch (err) {
        logEvent('activate.error', { error: (err as Error).message });
        await vscode.window.showErrorMessage(
            `C++ Docs failed to open the index database: ${(err as Error).message}. ` +
            'Try running "npm run rebuild:electron" in the project root and reloading the window.'
        );
        return;
    }
    logEvent('activate.docsets.opened', {
        count: docsets.listDocsets().length,
        hasAny: docsets.hasAnyDocset()
    });

    surfaces = new SurfaceManager();
    // Publish the persisted doc-panel location as a setContext key so
    // the WebviewView contribution's `when` clause in package.json can
    // hide the sidebar entry while the user has the panel docked in
    // the editor area. Single-source-of-truth lives in globalState.
    await writeDocPanelLocation(context, readDocPanelLocation(context));
    cppStandard = new CppStandardManager();
    welcomeDeps = {
        setContext: async (k, v) => {
            await vscode.commands.executeCommand('setContext', k, v);
        },
        hasAnyDocset: () => docsets!.hasAnyDocset(),
        // "can resolve" is meaningful iff there's at least one docset to
        // resolve into.
        canResolve: () => docsets!.hasAnyDocset()
    };

    statusItem = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    context.subscriptions.push(statusItem);

    await refreshHasDocsets();

    // Per-process install nudge. The `globalState`-keyed dedup persisted
    // across dev-host launches, so a dismissal (or any transient suppression)
    // silenced the prompt forever; a `let` flag re-arms on every fresh
    // activation, which matches the user's mental model.
    void maybePromptInstallOnEmpty();

    // Hoisted above the tree-view registration so the click handler can
    // close over them without forward-reference. Used by both the tree
    // selection handler and the later command/cursor-follow wiring.
    const bootstrapUri = vscode.Uri.joinPath(
        context.extensionUri,
        'dist',
        'client',
        'bootstrap.js'
    );

    const loaderDeps = (): PageLoaderDeps => ({
        docsets: docsets!,
        cppStandard: cppStandard!,
        attributionEnabled: readAttributionEnabled,
        respectVSCodeTheme: readRespectVSCodeTheme,
        zoomLevel: readZoomLevel,
        codeTheme: readCodeTheme,
        controls: readControlVisibility,
        surfaceKind: surfaces?.pickTarget() === 'panel' ? 'panel' : 'view'
    });

    // Tree-view registration moved here (was after the webview/serializer
    // setup) to close the activation-event timing window: the
    // `onView:cppDocs.docsetTree` event fires the instant the activitybar
    // container becomes visible after a window reload, and VSCode renders
    // "There is no data provider registered that can provide view data."
    // if `getChildren()` is asked before `createTreeView()` has returned.
    // We only need `docsets` (already opened) and `surfaces` (just
    // constructed) to register, so do it immediately.
    //
    // The `cppDocs.tree.enabled = false` knob is enforced by a `when` clause
    // on the view contribution itself (see `package.json` →
    // `views.cppDocs[0].when = "config.cppDocs.tree.enabled"`). When the
    // setting is false, VSCode does not contribute the view at all — no
    // "no data provider" error, no empty container — so we ALWAYS register
    // the provider here. Toggling the setting still requires a window
    // reload, but the reason is now the view contribution itself
    // disappearing/reappearing rather than our runtime skip.
    logEvent('activate.tree.enabled', {
        enabled:
            vscode.workspace
                .getConfiguration('cppDocs')
                .get<boolean>('tree.enabled') ?? true
    });
    treeProvider = new CppDocsTreeProvider(docsets);
    treeView = vscode.window.createTreeView<DocNode>('cppDocs.docsetTree', {
        treeDataProvider: treeProvider,
        showCollapseAll: true,
        canSelectMany: false
    });
    // Defensive nudge: if VSCode already gave up with the "no data
    // provider" message during the activation-event timing window
    // (docs/06-gotchas.md #15-#17), this fires onDidChangeTreeData so
    // it re-queries getChildren and re-renders.
    treeProvider.refresh();
    context.subscriptions.push(treeView);
    context.subscriptions.push({ dispose: () => treeProvider?.dispose() });

    const searchController = new SearchViewController(
        context.extensionUri,
        (query: string) => {
            if (!query || query.length === 0) {
                treeProvider?.setSearchResults(null, [], []);
                return;
            }
            const symbolHits = docsets?.searchSymbolsForFilter(query, 5000) ?? [];
            const pageHits = docsets?.searchContent(query, 50) ?? [];
            treeProvider?.setSearchResults(query, symbolHits, pageHits);
        }
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            SEARCH_VIEW_ID,
            searchController,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Sync the tree with the active page after every successful navigation
    // (regardless of which surface initiated). `tree.reveal({focus: false})`
    // selects without stealing keyboard focus from the editor / webview, per
    // the M3 acceptance bullet. Requires `getParent` on the provider
    // (docs/06-gotchas.md #15).
    //
    // VSCode's `TreeView.reveal()` makes the element visible, which also
    // brings the tree view's tab to the foreground when it shares a tab
    // group with the docs panel. We don't want to clobber the docs panel
    // the user is reading just to update tree selection — gate reveal on
    // `treeView.visible` and queue a pending node so the next time the
    // user opens the tree it lands on the right symbol.
    context.subscriptions.push(
        surfaces.onDidNavigate((target) => {
            void revealForNavTarget(target);
        })
    );
    context.subscriptions.push(
        treeView.onDidChangeVisibility((e) => {
            if (e.visible && pendingTreeReveal) {
                const node = pendingTreeReveal;
                pendingTreeReveal = undefined;
                treeView!.reveal(node, { select: true, focus: false }).then(undefined, () => {
                    // `reveal` rejects if an ancestor's getParent returns undefined.
                });
            }
        })
    );

    // Tree filter input — opens a modeless InputBox that narrows the tree
    // live as the user types. Empty value on accept/hide clears the filter.
    const setTreeFilter = async (value: string | null): Promise<void> => {
        treeProvider?.setFilter(value);
        await vscode.commands.executeCommand(
            'setContext',
            'cppDocs.treeFilterActive',
            treeProvider?.isFilterActive() ?? false
        );
    };

    context.subscriptions.push(
        vscode.commands.registerCommand('cppDocs.tree.setFilter', () => {
            const input = vscode.window.createInputBox();
            input.title = 'Filter C++ Docs Tree';
            input.placeholder = 'Substring of qualified name (case-insensitive)';
            input.value = treeProvider?.getFilter() ?? '';
            input.onDidChangeValue(async (value) => {
                await setTreeFilter(value.length > 0 ? value : null);
            });
            input.onDidAccept(() => {
                input.hide();
            });
            input.onDidHide(() => {
                input.dispose();
            });
            input.show();
        }),
        vscode.commands.registerCommand('cppDocs.tree.clearFilter', async () => {
            await setTreeFilter(null);
            treeProvider?.setSearchResults(null, [], []);
            searchController.clearSearch();
        })
    );

    // Symbol-node click → navigate active surface (no focus stolen from tree).
    context.subscriptions.push(
        treeView.onDidChangeSelection(async (e) => {
            const node = e.selection[0];
            if (!node || node.kind !== 'symbol') return;
            const hit = docsets!.getSymbolById(node.symbolId);
            if (!hit) return;
            // Skip when revealForNavTarget programmatically revealed this node to
            // sync the tree with the already-active page — not a user-initiated pick.
            const currentTarget = surfaces?.getActiveHistory()?.current();
            if (currentTarget?.docsetId === hit.docsetId &&
                currentTarget?.pagePath === hit.filePath) return;
            // Tree-click navigation should not pull focus away from the tree —
            // the user might want to keep arrow-keying through symbols. The
            // `cppDocs.tree.revealPanelOnSelection` setting (default true)
            // opts into force-revealing a hidden panel even though that
            // momentarily costs focus.
            await ensureActiveSurface({
                preserveFocus: true,
                forceReveal: readRevealPanelOnSelection()
            });
            const webview = surfaces?.getActiveWebview();
            const history = surfaces?.getActiveHistory();
            if (!webview || !history) return;
            const target = { docsetId: hit.docsetId, pagePath: hit.filePath };
            history.push(target);
            const ok = await loadPageInWebview(
                webview,
                bootstrapUri,
                target,
                loaderDeps()
            );
            if (ok) surfaces?.notifyNavigated(target);
        })
    );

    // Non-blocking update check. Fires once per `activate()` call and never
    // blocks the activation Promise.
    if (readCheckForUpdatesEnabled()) {
        void runUpdateCheck(context.globalState);
    }

    // Auto-reindex when the indexer logic has advanced past what produced
    // the user's stored data. Runs silently in the background — never
    // blocks activation. The reindex uses the already-cached on-disk
    // cppreference files (no download), so this is fast and offline-safe.
    void runIndexerVersionCheck(context.globalState);

    context.subscriptions.push({
        dispose: () => {
            docsets?.close();
            docsets = undefined;
        }
    });
    context.subscriptions.push(cppStandard);

    const panelDeps = (): PanelDeps => ({
        ...loaderDeps(),
        extensionUri: context.extensionUri,
        bootstrapUri,
        manager: surfaces!
    });

    // Broadcast a `setCodeTheme` message to every open surface when the
    // `cppDocs.codeTheme` setting changes — from the Settings UI, from a
    // workspace `.vscode/settings.json` edit, or from the in-webview
    // picker (which writes the setting; this watcher fans out the update).
    // Live-swap rather than re-render: the client just rewrites the
    // `<style id="cppref-code-theme-vars">` block.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration((evt) => {
            if (!evt.affectsConfiguration('cppDocs.codeTheme')) return;
            const theme = getCodeTheme(readCodeTheme());
            const msg: HostToClientMessage = {
                type: 'setCodeTheme',
                themeId: theme.id,
                kind: theme.kind,
                cssVars: buildCodeThemeCssVars(theme)
            };
            const panel = surfaces?.getPanel();
            const view = surfaces?.getView();
            if (panel) void panel.webview.postMessage(msg);
            if (view) void view.webview.postMessage(msg);
            logEvent('codeTheme.broadcast', { themeId: theme.id, kind: theme.kind });
        })
    );

    // Re-render the active surface when any `cppDocs.controls.*`
    // visibility toggle changes — there is no live-swap path for the
    // floating control widgets (they're injected once at bootstrap),
    // so we re-render the current page so the new toggle state is
    // reflected. Cheap: a single page-load through the cache.
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async (evt) => {
            if (!evt.affectsConfiguration('cppDocs.controls')) return;
            const target = surfaces?.getActiveHistory()?.current();
            const webview = surfaces?.getActiveWebview();
            if (!target || !webview) return;
            const ok = await loadPageInWebview(
                webview,
                bootstrapUri,
                target,
                loaderDeps()
            );
            if (ok) surfaces?.notifyNavigated(target);
        })
    );

    // Assemble the production resolver chain. The per-strategy timeout is
    // re-read inside the composer's race so it cannot be tuned at runtime
    // without a window reload (acceptable — an obscure setting).
    const resolver = buildProductionResolver({
        vscode,
        index: docsets,
        config: () => ({
            timeoutMs:
                vscode.workspace
                    .getConfiguration('cppDocs')
                    .get<number>('resolver.timeoutMs') ?? 250,
            preferLanguageServer:
                vscode.workspace
                    .getConfiguration('cppDocs')
                    .get<boolean>('resolver.preferLanguageServer') ?? true
        })
    });

    // Hover provider. Registered for `cpp` and `c`; bails inside
    // `provideHover` if `cppDocs.hover.enabled` is false so the toggle is
    // live without a window reload.
    const hoverProvider = new CppDocsHoverProvider({
        resolver,
        docsets: docsets,
        enabled: () =>
            vscode.workspace
                .getConfiguration('cppDocs')
                .get<boolean>('hover.enabled') ?? true,
        attributionEnabled: readAttributionEnabled,
        hasAnyDocset: () => docsets!.hasAnyDocset(),
        log: logEvent
    });
    context.subscriptions.push(
        vscode.languages.registerHoverProvider(
            ['cpp', 'c', 'cuda-cpp', 'objective-c', 'objective-cpp'],
            hoverProvider
        )
    );

    // Tracked across cursor-follow invocations so a parked cursor on the
    // same symbol doesn't keep re-rendering the page. `lastNoDocsetsFqn`
    // dedups the Fix C "not installed" placeholder so the surface
    // doesn't thrash as the cursor moves over the same name.
    const cursorFollowState: {
        lastShownSymbolId: number | undefined;
        lastNoDocsetsFqn: string | undefined;
    } = {
        lastShownSymbolId: undefined,
        lastNoDocsetsFqn: undefined
    };

    const cursorFollowSurfaces: CursorFollowSurfaces = {
        // Cursor-follow MUST NOT steal keyboard focus from the editor.
        // Passing `preserveFocus: true` ensures every reveal/show invocation
        // routed through this path keeps the user typing.
        ensureActiveSurface: () => ensureActiveSurface({ preserveFocus: true }),
        getActiveWebview: () => surfaces?.getActiveWebview(),
        getActiveHistory: () => surfaces?.getActiveHistory(),
        notifyNavigated: (target) => surfaces?.notifyNavigated(target),
        // onMissBehavior=clearPanel wipes the surface to a blank attribution-only
        // page so the prior content can't be mistaken for a description of the
        // current symbol.
        renderEmptyPage: async () => {
            const wv = surfaces?.getActiveWebview();
            if (!wv) return;
            renderEmptyPage(wv, bootstrapUri, loaderDeps());
        },
        // onMissBehavior=showLink renders a "No docs page for <fqn>" placeholder
        // with a single link that fires `cppDocs.openSymbol` pre-filled with the FQN.
        renderMissPlaceholder: async (fqn) => {
            const wv = surfaces?.getActiveWebview();
            if (!wv) return;
            renderMissPlaceholder(wv, bootstrapUri, fqn, loaderDeps());
        },
        // "C++ Docs is not installed yet" placeholder. Distinct from
        // `renderMissPlaceholder`: this one offers an Install link
        // (the docset is missing entirely) rather than a Search link.
        renderNotInstalledPlaceholder: async (fqn) => {
            const wv = surfaces?.getActiveWebview();
            if (!wv) return;
            renderNotInstalledPlaceholder(wv, bootstrapUri, fqn, loaderDeps());
        }
    };

    const viewProvider = new DocPanelViewProvider(
        context.extensionUri,
        bootstrapUri,
        surfaces,
        cppStandard,
        docsets,
        readAttributionEnabled,
        readRespectVSCodeTheme,
        readCodeTheme,
        readControlVisibility,
        readZoomLevel
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            DOC_PANEL_VIEW_ID,
            viewProvider,
            { webviewOptions: { retainContextWhenHidden: false } }
        )
    );

    context.subscriptions.push(
        vscode.window.registerWebviewPanelSerializer(
            PANEL_VIEW_TYPE,
            new DocPanelSerializer(panelDeps())
        )
    );

    async function navigateActiveSurface(
        moveActive: () => { docsetId: number; pagePath: string } | undefined
    ): Promise<void> {
        const history = surfaces?.getActiveHistory();
        const webview = surfaces?.getActiveWebview();
        if (!history || !webview) return;
        const target = moveActive();
        if (!target) return;
        const ok = await loadPageInWebview(
            webview,
            bootstrapUri,
            target,
            loaderDeps()
        );
        if (ok) surfaces?.notifyNavigated(target);
    }

    /**
     * Resolve a `NavTarget` back to the corresponding tree node and reveal it
     * without stealing focus. Bridges the page-loader output (file-path tuple)
     * to the tree provider's domain (DocNode chain). When the active filter
     * excludes the symbol, clear it first so the user can see where they
     * landed — silently filtering away the just-navigated symbol is a worse UX
     * than a brief filter-cleared moment.
     */
    async function revealForNavTarget(target: {
        docsetId: number;
        pagePath: string;
    }): Promise<void> {
        if (!treeProvider || !treeView || !docsets) return;
        const hit = docsets.findSymbolByPath(target.docsetId, target.pagePath);
        if (!hit) return;
        let node = treeProvider.findNodeForSymbol(hit);
        if (!node && treeProvider.isFilterActive()) {
            // UX: clearing the filter is preferred over silently revealing nothing.
            treeProvider.setFilter(null);
            await vscode.commands.executeCommand(
                'setContext',
                'cppDocs.treeFilterActive',
                false
            );
            node = treeProvider.findNodeForSymbol(hit);
        }
        if (!node) return;
        if (!treeView.visible) {
            // Tree is hidden behind another tab in its tab group (most often the
            // docs panel itself). Calling `reveal` would switch tabs and hide the
            // page the user is reading. Stash the node and reveal it the next
            // time the tree becomes visible.
            pendingTreeReveal = node;
            return;
        }
        try {
            await treeView.reveal(node, { select: true, focus: false });
        } catch {
            // `reveal` rejects if `getParent` ever returns undefined for an
            // ancestor — defensive swallow rather than escalate to the user.
        }
    }

    async function pickSymbol(prefill?: string): Promise<SymbolHit | undefined> {
        if (!docsets || !docsets.hasAnyDocset()) {
            const choice = await vscode.window.showInformationMessage(
                'No docset installed. Install cppreference?',
                'Install',
                'Cancel'
            );
            if (choice === 'Install') {
                await vscode.commands.executeCommand('cppDocs.installCppreference');
            }
            return undefined;
        }

        interface SymbolPickItem extends vscode.QuickPickItem {
            hit: SymbolHit;
        }

        const qp = vscode.window.createQuickPick<SymbolPickItem>();
        qp.placeholder =
            'Type a qualified name (e.g. std::vector::push_back) — case-insensitive prefix search';
        qp.matchOnDescription = false;
        qp.matchOnDetail = false;

        const seed = (value: string): void => {
            if (!value || value.length < 2) {
                qp.items = [];
                return;
            }
            // Case-insensitive prefix search. The tree-filter input is already
            // case-insensitive (LIKE COLLATE NOCASE); making the QuickPick
            // consistent removes the user-visible discrepancy.
            const hits = docsets!.searchPrefixCI(value, 50);
            qp.items = hits.map((h) => ({
                label: h.qualifiedName,
                description: `${h.kind} · ${h.docsetName}`,
                hit: h
            }));
        };

        qp.onDidChangeValue(seed);

        if (prefill && prefill.length > 0) {
            // Pre-fill the QuickPick value (and its results) so the showLink
            // placeholder's "Search docsets" link lands the user in a populated
            // picker rather than an empty input.
            qp.value = prefill;
            seed(prefill);
        }

        return new Promise<SymbolHit | undefined>((resolve) => {
            qp.onDidAccept(() => {
                const selected = qp.selectedItems[0];
                qp.hide();
                resolve(selected?.hit);
            });
            qp.onDidHide(() => {
                qp.dispose();
                resolve(undefined);
            });
            qp.show();
        });
    }

    /**
     * Ensure a documentation surface is reachable. `preserveFocus` (default
     * `false`) opens the surface as the active widget — fine for explicit
     * user actions (Open Symbol command, tree click). The cursor-follow
     * and hover paths pass `true` so moving the cursor never yanks focus
     * from the editor mid-typing.
     *
     * When `createIfMissing` is `true` (the default), this opens the
     * configured primary surface if neither view nor panel is currently
     * attached. Cursor-follow passes `false` for the second-to-fourth
     * cursor moves of a session (after the first `renderNotInstalledPlaceholder`
     * already opened a surface) so a parked cursor never re-opens the
     * panel after the user closed it.
     */
    async function ensureActiveSurface(
        options: {
            preserveFocus?: boolean;
            createIfMissing?: boolean;
            forceReveal?: boolean;
        } = {}
    ): Promise<void> {
        const preserveFocus = options.preserveFocus ?? false;
        const createIfMissing = options.createIfMissing ?? true;
        const forceReveal = options.forceReveal ?? false;

        if (surfaces?.hasView() || surfaces?.hasPanel()) {
            const target = surfaces.pickTarget();
            if (target === 'view') {
                const view = surfaces.getView();
                if (view) {
                    // `WebviewView.show(preserveFocus=true)` is the focus-safe
                    // reveal but only expands the view inside an already-open
                    // sidebar group — it cannot unhide a collapsed container
                    // (see toggleDocPanel comment around `toggleAuxiliaryBar`).
                    // When the caller asked to force-reveal and the view is
                    // currently hidden, escalate to the focus command, which
                    // is the only API that can open the sidebar group itself
                    // (at the cost of momentarily grabbing focus).
                    if (forceReveal && !view.visible) {
                        await vscode.commands.executeCommand(`${DOC_PANEL_VIEW_ID}.focus`);
                    } else {
                        view.show(preserveFocus);
                    }
                } else if (!preserveFocus || forceReveal) {
                    await vscode.commands.executeCommand(`${DOC_PANEL_VIEW_ID}.focus`);
                }
            } else if (target === 'panel') {
                surfaces.getPanel()!.reveal(undefined, preserveFocus);
            }
            return;
        }
        if (!createIfMissing) return;
        // Single-instance: the persisted location decides which surface
        // to open. The other surface's view contribution is hidden via
        // setContext, so there is no risk of accidentally creating both.
        if (readDocPanelLocation(context) === 'editor') {
            await createOrRevealPanel(panelDeps(), { preserveFocus });
        } else if (preserveFocus && !forceReveal) {
            // Focus-safe path: only reveal if the view is already attached.
            // Skipping mid-typing (cursor-follow / hover) avoids yanking
            // focus from the editor when the sidebar would have to be
            // opened from scratch.
            const view = surfaces?.getView();
            if (view)
                view.show(true);
        } else {
            // Either an explicit user command (preserveFocus=false) or a
            // tree-selection opt-in (forceReveal=true). Both want the
            // panel to actually appear — `<viewId>.focus` is the only API
            // that can create+reveal an unattached webview view in one
            // step, even though it momentarily grabs focus.
            await vscode.commands.executeCommand(`${DOC_PANEL_VIEW_ID}.focus`);
        }
    }

    // Cursor-follow subscription. The debounce delay re-reads the configured
    // value on every fire so users can tune `cppDocs.panel.followCursorDebounceMs`
    // without a window reload.
    const debouncedCursorFollow = debounce(
        async (e: vscode.TextEditorSelectionChangeEvent): Promise<void> => {
            const pos = e.selections[0]?.active;
            if (!pos) return;
            await handleCursorChange(
                {
                    resolver,
                    docsets: docsets!,
                    surfaces: cursorFollowSurfaces,
                    loadPage: (webview, target) =>
                        loadPageInWebview(webview, bootstrapUri, target, loaderDeps()),
                    followCursor: () =>
                        vscode.workspace
                            .getConfiguration('cppDocs')
                            .get<boolean>('panel.followCursor') ?? true,
                    onMissBehavior: () => {
                        const v = vscode.workspace
                            .getConfiguration('cppDocs')
                            .get<string>('panel.onMissBehavior');
                        return v === 'stay' || v === 'clearPanel' || v === 'showLink'
                            ? (v as OnMissBehavior)
                            : 'showLink';
                    },
                    hasAnyDocset: () => docsets!.hasAnyDocset(),
                    state: cursorFollowState,
                    log: logEvent
                },
                e.textEditor.document,
                pos
            );
        },
        () =>
            vscode.workspace
                .getConfiguration('cppDocs')
                .get<number>('panel.followCursorDebounceMs') ?? 150
    );
    context.subscriptions.push(
        vscode.window.onDidChangeTextEditorSelection(debouncedCursorFollow),
        { dispose: () => debouncedCursorFollow.cancel() }
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'cppDocs.openSymbol',
            async (prefill?: unknown) => {
                // Accept an optional first arg (string) to pre-fill the QuickPick
                // value. Any non-string is ignored so the command palette entry
                // (invoked with no arguments) behaves unchanged.
                const seed = typeof prefill === 'string' ? prefill : undefined;
                const hit = await pickSymbol(seed);
                if (!hit)
                    return;

                await ensureActiveSurface();
                const webview = surfaces?.getActiveWebview();
                const history = surfaces?.getActiveHistory();
                if (!webview || !history)
                    return;

                const target = {
                    docsetId: hit.docsetId,
                    pagePath: hit.filePath,
                };

                history.push(target);
                const ok = await loadPageInWebview(
                    webview,
                    bootstrapUri,
                    target,
                    loaderDeps()
                );

                if (ok)
                    surfaces?.notifyNavigated(target);
            }
        ),

        // Tree-item click target — declared by `tree-provider.ts` on every symbol
        // node's `command` field. Args: `{ docsetId, symbolId }`. Treated as a
        // best-effort: stale tree state (docset removed between render and click)
        // resolves to no-hit and we silently no-op rather than surfacing an error.
        vscode.commands.registerCommand(
            OPEN_SYMBOL_FROM_TREE_COMMAND,
            async (arg: { docsetId: number; symbolId: number } | number) => {
                const symbolId = typeof arg === 'number' ? arg : arg?.symbolId;
                if (typeof symbolId !== 'number')
                    return;

                const hit = docsets!.getSymbolById(symbolId);
                if (!hit)
                    return;

                // onDidChangeSelection fires first on user tree clicks and navigates
                // to the target; by the time this command fires the history current
                // already matches — skip to avoid a duplicate push.
                const currentTarget = surfaces?.getActiveHistory()?.current();
                if (currentTarget?.docsetId === hit.docsetId &&
                    currentTarget?.pagePath === hit.filePath) return;
                // Tree-click navigation should not pull keyboard focus away from
                // the tree item the user just clicked. The
                // `cppDocs.tree.revealPanelOnSelection` setting (default true)
                // opts into force-revealing a hidden panel.
                await ensureActiveSurface({
                    preserveFocus: true,
                    forceReveal: readRevealPanelOnSelection()
                });

                const webview = surfaces?.getActiveWebview();
                const history = surfaces?.getActiveHistory();
                if (!webview || !history)
                    return;

                const target = {
                    docsetId: hit.docsetId,
                    pagePath: hit.filePath,
                };

                history.push(target);
                const ok = await loadPageInWebview(
                    webview,
                    bootstrapUri,
                    target,
                    loaderDeps()
                );

                if (ok)
                    surfaces?.notifyNavigated(target);
            }
        ),

        vscode.commands.registerCommand(
            OPEN_PAGE_FROM_SEARCH_COMMAND,
            async (arg: { docsetId: number; filePath: string }) => {
                if (!arg || typeof arg.docsetId !== 'number') return;
                await ensureActiveSurface({
                    preserveFocus: true,
                    forceReveal: readRevealPanelOnSelection()
                });

                const webview = surfaces?.getActiveWebview();
                const history = surfaces?.getActiveHistory();
                if (!webview || !history)
                    return;

                const target = {
                    docsetId: arg.docsetId,
                    pagePath: arg.filePath,
                };

                history.push(target);
                const ok = await loadPageInWebview(webview, bootstrapUri, target, loaderDeps());
                if (ok)
                    surfaces?.notifyNavigated(target);
            }
        ),

        vscode.commands.registerCommand('cppDocs.toggleDocPanel', async () => {
            const panel = surfaces?.getPanel();
            const view = surfaces?.getView();
            const location = readDocPanelLocation(context);

            if (location === 'editor') {
                if (panel?.visible) {
                    // Editor tab visible — close it entirely. The dispose path
                    // retains panelHistory, so reopen lands on the same page.
                    panel.dispose();
                } else if (panel) {
                    panel.reveal(undefined, false);
                } else {
                    await createOrRevealPanel(panelDeps());
                }
            } else if (view?.visible) {
                // No VS Code API hides a single WebviewView — the only
                // option is collapsing its container. The view lives in
                // the secondary sidebar by default, so toggle that.
                await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
            } else {
                await vscode.commands.executeCommand(`${DOC_PANEL_VIEW_ID}.focus`);
            }
        }),

        /**
         * Move the docs panel from the sidebar / bottom panel into an
         * editor tab. Atomic per the single-instance invariant:
         *   1. Promote the view's NavigationHistory onto the panel side
         *      so the new editor tab opens on the same page.
         *   2. Flip the persisted location to 'editor' and update the
         *      setContext key — this immediately removes the sidebar
         *      view contribution (its `when` clause is bound to
         *      `cppDocs.location != 'editor'`).
         *   3. Dispose any pre-existing panel (paranoia — under normal
         *      flow there is none).
         *   4. Create the new panel, which auto-restores the promoted
         *      history's current target.
         */
        vscode.commands.registerCommand('cppDocs.moveToEditorTab', async () => {
            if (!surfaces)
                return;

            surfaces.adoptViewHistoryToPanel();
            await writeDocPanelLocation(context, 'editor');

            surfaces.getPanel()?.dispose();
            await createOrRevealPanel(panelDeps(), {
                preserveFocus: false
            });
        }),

        /**
         * Reverse of `cppDocs.moveToEditorTab`. Disposes the editor tab,
         * flips the persisted location back to 'sidebar' (which re-shows
         * the WebviewView contribution), and focuses the sidebar view.
         * The view's `resolveWebviewView` picks up the adopted history
         * and restores the page the user was viewing in the editor tab.
         */
        vscode.commands.registerCommand('cppDocs.dockInSidebar', async () => {
            if (!surfaces)
                return;

            surfaces.adoptPanelHistoryToView();
            surfaces.getPanel()?.dispose();

            await writeDocPanelLocation(context, 'sidebar');
            await vscode.commands.executeCommand(`${DOC_PANEL_VIEW_ID}.focus`);
        }),

        vscode.commands.registerCommand('cppDocs.showOutput', () => {
            getOutputChannel().show();
        }),

        vscode.commands.registerCommand('cppDocs.back', async () => {
            await navigateActiveSurface(() =>
                surfaces?.getActiveHistory()?.goBack()
            );
        }),

        vscode.commands.registerCommand('cppDocs.forward', async () => {
            await navigateActiveSurface(() =>
                surfaces?.getActiveHistory()?.goForward()
            );
        }),

        vscode.commands.registerCommand('cppDocs.setCppStandard', async () => {
            const items: vscode.QuickPickItem[] = [
                { label: 'auto', description: 'Resolve via MS C/C++ ext → compile_commands.json → fallback' },
                ...SELECTABLE_STANDARDS.map((tok) => ({ label: tokenToSetting(tok) }))
            ];
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Filter cppreference content for this C++ standard'
            });
            if (!pick) return;
            await vscode.workspace
                .getConfiguration('cppDocs')
                .update(
                    'cppStandard',
                    pick.label,
                    vscode.ConfigurationTarget.Workspace
                );
        }),

        vscode.commands.registerCommand('cppDocs.installCppreference', async () => {
            try {
                const pinned = readPinnedVersion();
                const versionArg = pinned === 'latest' ? undefined : pinned;
                const result = await withProgress(
                    'C++ Docs: Installing cppreference',
                    (report) => docsets!.installCppreference(report, versionArg)
                );
                // Successful install resets the "update available" hint (the user is
                // now at the version we previously flagged) so the status-bar reverts
                // to the standard installed-summary text.
                updateAvailableVersion = undefined;
                // Re-arm the in-process nudge so a future removal during this same
                // session re-prompts.
                installPromptShownThisSession = false;
                await refreshHasDocsets();
                refreshSurfacesAfterDocsetChange(context);
                const verb = result.status === 'already-current' ? 'already at' : 'installed';
                await vscode.window.showInformationMessage(
                    `cppreference ${verb} version ${result.version} (${result.inserted} symbols)`
                );
            } catch (err) {
                await vscode.window.showErrorMessage(
                    `Install failed: ${(err as Error).message}`
                );
            }
        }),

        vscode.commands.registerCommand('cppDocs.removeDocset', async () => {
            const installed = docsets!.listDocsets();
            if (installed.length === 0) {
                await vscode.window.showInformationMessage('C++ Docs: no docsets installed');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                installed.map((d) => ({
                    label: d.name,
                    description: `${d.source}${d.version ? ` ${d.version}` : ''}`,
                    id: d.id
                })),
                { placeHolder: 'Remove which docset?' }
            );
            if (!pick) return;
            try {
                docsets!.removeDocset(pick.id);
                // Re-arm the in-process install nudge so removing the last
                // docset can prompt the user again the next time they hit a
                // resolvable FQN — without this, a user who removes after
                // having already seen the activation prompt loses the
                // discoverability path entirely.
                installPromptShownThisSession = false;
                await refreshHasDocsets();
                refreshSurfacesAfterDocsetChange(context);
                await vscode.window.showInformationMessage(`Removed ${pick.label}`);
            } catch (err) {
                await vscode.window.showErrorMessage(`C++ Docs: failed to remove docset — ${String(err)}`);
            }
        }),

        vscode.commands.registerCommand('cppDocs.openCurrentInBrowser', async () => {
            const history = surfaces?.getActiveHistory();
            const target = history?.current();
            if (!target) {
                await vscode.window.showInformationMessage('No active C++ Docs page.');
                return;
            }
            const upstream = `https://en.cppreference.com/w/${target.pagePath.replace(/\.html$/, '')}`;
            await vscode.env.openExternal(vscode.Uri.parse(upstream));
        }),

        vscode.commands.registerCommand('cppDocs.diagnose', async () => {
            const channel = getOutputChannel();
            channel.show(true);
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                channel.appendLine('--- C++ Docs Diagnose: no active editor');
                return;
            }
            const doc = editor.document;
            const pos = editor.selection.active;
            channel.appendLine(
                `--- C++ Docs Diagnose @ ${doc.uri.fsPath}:${pos.line + 1}:${pos.character + 1} (lang=${doc.languageId})`
            );
            const wordRange = doc.getWordRangeAtPosition(pos);
            const word = wordRange ? doc.getText(wordRange) : '<no word>';
            channel.appendLine(`  word: "${word}"`);
            try {
                const resolved = await resolver.resolve(doc, pos);
                if (!resolved) {
                    channel.appendLine('  resolve: <miss> — chain returned undefined');
                } else {
                    channel.appendLine(
                        `  resolve: { fqn: "${resolved.fqn}", source: ${resolved.source ?? '<unset>'} }`
                    );
                    const exact = docsets!.lookupExact(resolved.fqn);
                    channel.appendLine(
                        exact
                            ? `  lookupExact: { qualifiedName: "${exact.qualifiedName}", kind: ${exact.kind}, filePath: ${exact.filePath} }`
                            : '  lookupExact: <miss>'
                    );
                    const best = docsets!.lookupBest(resolved.fqn);
                    channel.appendLine(
                        best
                            ? `  lookupBest:  { qualifiedName: "${best.qualifiedName}", kind: ${best.kind}, filePath: ${best.filePath} }`
                            : '  lookupBest:  <miss>'
                    );
                }
            } catch (err) {
                channel.appendLine(`  resolve threw: ${(err as Error).message}`);
            }
            const docsList = docsets!.listDocsets();
            channel.appendLine(`  docsets: ${docsList.length}`);
            for (const d of docsList) {
                channel.appendLine(
                    `    - id=${d.id} name=${d.name} version=${d.version ?? '<none>'} source=${d.source}`
                );
            }
        }),

        vscode.commands.registerCommand('cppDocs.checkForUpdates', async () => {
            try {
                const pinned = readPinnedVersion();
                const versionArg = pinned === 'latest' ? undefined : pinned;
                const result = await withProgress(
                    'C++ Docs: Checking for cppreference updates',
                    (report) => docsets!.installCppreference(report, versionArg)
                );
                updateAvailableVersion = undefined;
                await refreshHasDocsets();
                refreshSurfacesAfterDocsetChange(context);
                const msg =
                    result.status === 'already-current'
                        ? `cppreference is up to date (${result.version})`
                        : `cppreference updated to ${result.version}`;
                await vscode.window.showInformationMessage(msg);
            } catch (err) {
                await vscode.window.showErrorMessage(
                    `Update check failed: ${(err as Error).message}`
                );
            }
        }),

    );

    logEvent('activate.complete');
}

/**
 * Fire the per-process "install cppreference" nudge when the extension
 * activates against zero installed docsets. The status-bar item already
 * advertises the empty state, but it's easy to miss on the right edge of the
 * bar — a non-blocking info message gets the attention without forcing a modal.
 *
 * Dedup is in-process (`installPromptShownThisSession`): a fresh dev-host
 * launch (e.g. F5 again) re-arms the prompt because it's exactly the kind of
 * moment where the user wants the reminder. The prior `globalState` dedup
 * persisted across launches, so once the user dismissed it (or any transient
 * bug suppressed it) they never saw the nudge again. Discoverability beats
 * one-and-done dedup here.
 */
async function maybePromptInstallOnEmpty(): Promise<void> {
    if (!docsets) return;
    if (docsets.hasAnyDocset()) return;
    if (installPromptShownThisSession) return;
    installPromptShownThisSession = true;

    const pick = await vscode.window.showInformationMessage(
        'C++ Docs: cppreference is not installed. Install now (~7 MB)?',
        'Install',
        'Later'
    );
    if (pick === 'Install') {
        await vscode.commands.executeCommand('cppDocs.installCppreference');
    }
}


/**
 * Compare the stored indexer version against the running code's
 * INDEXER_VERSION. When the stored version is older (or absent for an
 * existing install), silently kick off a reindex via installCppreference —
 * which preserves cached cppreference files, re-registers the docset, and
 * rebuilds the symbol/FTS tables. On success the new version is persisted so
 * subsequent activations are no-ops. Failures (e.g. no docset installed yet,
 * transient errors) are swallowed: this is best-effort maintenance, never
 * user-blocking.
 */
async function runIndexerVersionCheck(
    globalState: vscode.Memento
): Promise<void> {
    if (!docsets) return;
    const installed = docsets.listDocsets().find((d) => d.source === 'cppreference');
    if (!installed) return; // nothing to reindex yet
    const stored = globalState.get<number>(INDEXER_VERSION_KEY) ?? 1;
    if (stored >= INDEXER_VERSION) return;
    try {
        await docsets.installCppreference();
        await globalState.update(INDEXER_VERSION_KEY, INDEXER_VERSION);
    } catch {
        // Leave the stored version unchanged so the next activation retries.
    }
}

/**
 * Fire the activation-time update check. Pulls the latest tag from GitHub
 * Releases, compares to the installed cppreference docset, and (when newer)
 * flips the status-bar item into "update available" mode plus a one-time
 * information prompt. Errors are swallowed: a flaky network must never
 * escalate during activation.
 */
async function runUpdateCheck(
    globalState: vscode.Memento
): Promise<void> {
    if (!docsets) return;
    const installed = docsets.listDocsets().find((d) => d.source === 'cppreference');
    const decision = await evaluateUpdate({
        installedVersion: installed?.version ?? undefined,
        memento: {
            get: (key) => globalState.get<string>(key),
            update: async (key, value) => {
                await globalState.update(key, value);
            }
        }
    });
    if (decision.state !== 'update-available' || !decision.latestVersion) return;

    updateAvailableVersion = decision.latestVersion;
    refreshStatusItem();

    if (!decision.shouldPrompt) return;

    const pick = await vscode.window.showInformationMessage(
        `cppreference ${decision.latestVersion} is available. Update now?`,
        'Update',
        'Later'
    );
    if (pick === 'Update') {
        await vscode.commands.executeCommand('cppDocs.installCppreference');
    }
}

export function deactivate(): void {
    docsets?.close();
    docsets = undefined;
    surfaces = undefined;
    cppStandard?.dispose();
    cppStandard = undefined;
    welcomeDeps = undefined;
    treeProvider?.dispose();
    treeProvider = undefined;
    treeView = undefined;
}
