import * as vscode from 'vscode';
import type { CppStandardManager } from '../cpp-standard-manager.js';
import type { DocsetManager } from '../../docset/manager.js';
import { installHostMessageHandler } from '../../webview-host/host-messages.js';
import type { HostToClientMessage } from '../../webview-host/messages.js';
import { logEvent } from '../../util/output.js';
import { CPPREF_SCHEME } from '../../constants.js';
import { NavigationHistory } from './navigation.js';
import {
    loadPageInWebview,
    resolveNavHref,
    resolveNavHrefByPath,
    resolveNavHrefByPagePath,
    type PageLoaderDeps
} from './page-loader.js';
import { renderPlaceholder, type SharedRenderContext } from './shared.js';
import type { SurfaceManager } from './manager.js';

export const VIEW_ID = 'cppDocs.docPanel';

/**
 * Provider for the `cppDocs.docPanel` WebviewView. Houses one navigation
 * history per view instance; the host message handler routes 'nav' events
 * through the page loader, pushing each successful load onto the history.
 *
 * `localResourceRoots` is fixed at panel creation (docs/06-gotchas.md #6),
 * so we include every currently-installed docset's documents directory at
 * resolve time. Docsets installed after the view is open won't be reachable
 * until the user closes and reopens the view.
 */
export class DocPanelViewProvider implements vscode.WebviewViewProvider {
    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly bootstrapUri: vscode.Uri,
        private readonly manager: SurfaceManager,
        private readonly cppStandard: CppStandardManager,
        private readonly docsets: DocsetManager,
        private readonly attributionEnabled: () => boolean,
        private readonly respectVSCodeTheme: () => boolean = () => true,
        private readonly codeTheme: () => string | undefined = () => undefined,
        private readonly controls?: () => {
            showZoom?: boolean;
            showThemePicker?: boolean;
            showNavButtons?: boolean;
        },
        private readonly zoomLevel: () => number = () => 1.0
    ) { }

    async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
        const docsetRoots = this.docsets
            .listDocsets()
            .map((d) => vscode.Uri.file(d.documentsDir));
        view.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri, ...docsetRoots]
        };

        // Set HTML synchronously before the first `await` so VS Code's CSP
        // check (which fires when enableScripts is set) always finds a valid
        // meta CSP tag. The placeholder will be replaced below if a prior
        // page can be restored.
        const placeholderCtx: SharedRenderContext = {
            webview: view.webview,
            bootstrapUri: this.bootstrapUri,
            respectVSCodeTheme: this.respectVSCodeTheme(),
            zoomLevel: this.zoomLevel(),
            codeTheme: this.codeTheme(),
            surfaceKind: 'view',
            ...(this.controls ? { controls: this.controls() } : {})
        };
        view.webview.html = renderPlaceholder(placeholderCtx, {
            attribution: { pagePath: 'cpp', enabled: this.attributionEnabled() },
            cppStandard: this.cppStandard.current().token,
            noDocsets: !this.docsets.hasAnyDocset()
        });

        // Fix A — if VSCode previously tore down this view (sidebar
        // collapse, focus transition, `retainContextWhenHidden: false`) and
        // we already had a NavTarget loaded, restore that target rather
        // than wiping the surface back to the placeholder. Without this,
        // every visibility flip clobbers cursor-follow's update with a
        // welcome page.
        //
        // The manager retains the per-surface history across `detachView`
        // / `attachView` cycles so the active target survives the cycle.
        const existingHistory = this.manager.getViewHistory();
        const history = existingHistory ?? new NavigationHistory();
        const docsetIds = this.docsets.listDocsets().map((d) => d.id);
        this.manager.attachView(view, history, docsetIds);

        const deps: PageLoaderDeps = {
            docsets: this.docsets,
            cppStandard: this.cppStandard,
            attributionEnabled: this.attributionEnabled,
            respectVSCodeTheme: this.respectVSCodeTheme,
            zoomLevel: this.zoomLevel,
            codeTheme: this.codeTheme,
            surfaceKind: 'view',
            ...(this.controls ? { controls: this.controls } : {})
        };

        const messageDisposable = installHostMessageHandler(view.webview, {
            onNav: async (href) => {
                const target = href.startsWith(CPPREF_SCHEME)
                    ? resolveNavHrefByPagePath(href.slice(CPPREF_SCHEME.length), this.docsets)
                    : (resolveNavHref(href, view.webview, this.docsets) ??
                        resolveNavHrefByPath(href, this.docsets));
                logEvent('view.click.nav', { href, resolved: !!target });
                if (!target) {
                    logEvent('view.click.nav.unmatched', { href });
                    const parsed = vscode.Uri.parse(href);
                    if (parsed.scheme === 'http' || parsed.scheme === 'https') {
                        await vscode.env.openExternal(parsed);
                    }
                    return;
                }
                logEvent('view.click.nav.matched', {
                    docsetId: target.docsetId,
                    pagePath: target.pagePath
                });
                history.push(target);
                const ok = await loadPageInWebview(
                    view.webview,
                    this.bootstrapUri,
                    target,
                    deps
                );
                if (ok) this.manager.notifyNavigated(target);
            },
            onState: ({ scrollY }) => {
                const current = history.current();
                if (current) history.replaceCurrent({ ...current, scrollY });
            },
            onZoomDelta: async (delta) => {
                const next = Math.round((
                    (vscode.workspace.getConfiguration('cppDocs').get<number>('panel.zoomLevel') ?? 1.0)
                    + delta) * 100) / 100;
                const clamped = Math.min(3.0, Math.max(0.5, next));
                await vscode.workspace.getConfiguration('cppDocs')
                    .update('panel.zoomLevel', clamped, vscode.ConfigurationTarget.Global);
                void view.webview.postMessage({ type: 'setZoom', value: clamped });
            },
            onPickCodeTheme: async (themeId) => {
                // Single source of truth is the setting; the extension-level
                // config watcher broadcasts the resulting palette to every
                // open surface so panel and view stay in sync.
                await vscode.workspace.getConfiguration('cppDocs')
                    .update('codeTheme', themeId, vscode.ConfigurationTarget.Global);
            },
            onReady: () => {
                logEvent('view.client.ready');
            },
            onClick: (info) => {
                const matchesBase = info.resolvedHref.startsWith(info.docsetWebviewBase);
                const fields: Record<string, unknown> = {
                    decision: info.decision,
                    rawHref: info.rawHref,
                    matchesBase,
                    inInteractive: info.inInteractiveAncestor,
                    externalMarker: info.hasExternalMarker
                };
                if (!matchesBase) {
                    fields['resolvedHref'] = info.resolvedHref.slice(0, 150);
                    fields['docsetBase'] = info.docsetWebviewBase.slice(0, 150);
                }
                logEvent('view.click', fields);
            }
        });
        const standardDisposable = this.cppStandard.onChange((next) => {
            const msg: HostToClientMessage = {
                type: 'setStandard',
                value: next.token
            };
            void view.webview.postMessage(msg);
        });
        view.onDidDispose(() => {
            messageDisposable.dispose();
            standardDisposable.dispose();
            this.manager.detachView();
        });
        // Try to restore the prior active target; placeholder is already set
        // above so we just return if nothing to restore. `loadPageInWebview`
        // returns false when the saved page no longer resolves — in that case
        // the placeholder rendered above stays as the final content.
        const target = history.current();
        if (target) {
            const ok = await loadPageInWebview(
                view.webview,
                this.bootstrapUri,
                target,
                deps
            );
            if (ok) this.manager.notifyNavigated(target);
        }
    }
}
