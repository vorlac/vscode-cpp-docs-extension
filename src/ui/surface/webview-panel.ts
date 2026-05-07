import * as vscode from 'vscode';
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

export const PANEL_VIEW_TYPE = 'cppDocs.viewer';
export const PANEL_TITLE = 'C++ Reference';

export interface PanelDeps extends PageLoaderDeps {
    extensionUri: vscode.Uri;
    bootstrapUri: vscode.Uri;
    manager: SurfaceManager;
}

/**
 * Wire the message handler, navigation history, standard-change
 * subscription, and dispose hooks for a freshly-created (or
 * deserialized) WebviewPanel. Returns the history so the serializer can
 * restore prior state into it.
 *
 * Fix A — when the manager already has a panel history (e.g. user
 * disposed the panel mid-session and is reopening it), reuse that
 * history so the navigation thread survives the panel's death/rebirth
 * cycle. New session → fresh history.
 */
function attachPanel(
    panel: vscode.WebviewPanel,
    deps: PanelDeps
): NavigationHistory {
    const existingHistory = deps.manager.getPanelHistory();
    const history = existingHistory ?? new NavigationHistory();
    const docsetIds = deps.docsets.listDocsets().map((d) => d.id);
    deps.manager.attachPanel(panel, history, docsetIds);

    // Lock the surfaceKind in so the webview-client renders the
    // dock-in-sidebar variant of the location button on every page
    // load that originates from this attachment, regardless of what
    // (if anything) the caller's `deps.surfaceKind` already says.
    const panelDeps: PanelDeps = { ...deps, surfaceKind: 'panel' };

    const messageDisposable = installHostMessageHandler(panel.webview, {
        onNav: async (href) => {
            const target = href.startsWith(CPPREF_SCHEME)
                ? resolveNavHrefByPagePath(href.slice(CPPREF_SCHEME.length), panelDeps.docsets)
                : (resolveNavHref(href, panel.webview, panelDeps.docsets) ??
                    resolveNavHrefByPath(href, panelDeps.docsets));
            logEvent('panel.click.nav', { href, resolved: !!target });
            if (!target) {
                logEvent('panel.click.nav.unmatched', { href });
                const parsed = vscode.Uri.parse(href);
                if (parsed.scheme === 'http' || parsed.scheme === 'https') {
                    await vscode.env.openExternal(parsed);
                }
                return;
            }
            logEvent('panel.click.nav.matched', {
                docsetId: target.docsetId,
                pagePath: target.pagePath
            });
            history.push(target);
            const ok = await loadPageInWebview(
                panel.webview,
                panelDeps.bootstrapUri,
                target,
                panelDeps
            );
            if (ok) panelDeps.manager.notifyNavigated(target);
        },
        onState: ({ scrollY }) => {
            const current = history.current();
            if (current) {
                history.replaceCurrent({ ...current, scrollY });
            }
        },
        onZoomDelta: async (delta) => {
            const next = Math.round((
                (vscode.workspace.getConfiguration('cppDocs').get<number>('panel.zoomLevel') ?? 1.0)
                + delta) * 100) / 100;
            const clamped = Math.min(3.0, Math.max(0.5, next));
            await vscode.workspace.getConfiguration('cppDocs')
                .update('panel.zoomLevel', clamped, vscode.ConfigurationTarget.Global);
            void panel.webview.postMessage({ type: 'setZoom', value: clamped });
        },
        onPickCodeTheme: async (themeId) => {
            // Persist to settings — the extension-level config watcher
            // (see `activate()`) handles broadcasting `setCodeTheme` to every
            // open surface, so the panel and the sidebar view stay in sync
            // without us having to do it from two places.
            await vscode.workspace.getConfiguration('cppDocs')
                .update('codeTheme', themeId, vscode.ConfigurationTarget.Global);
        },
        onReady: () => {
            logEvent('panel.client.ready');
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
            logEvent('panel.click', fields);
        }
    });
    const standardDisposable = deps.cppStandard.onChange((next) => {
        const msg: HostToClientMessage = { type: 'setStandard', value: next.token };
        void panel.webview.postMessage(msg);
    });

    panel.onDidDispose(() => {
        messageDisposable.dispose();
        standardDisposable.dispose();
        deps.manager.detachPanel();
    });
    return history;
}

function panelWebviewOptions(deps: PanelDeps): vscode.WebviewOptions {
    const docsetRoots = deps.docsets
        .listDocsets()
        .map((d) => vscode.Uri.file(d.documentsDir));
    return {
        enableScripts: true,
        localResourceRoots: [deps.extensionUri, ...docsetRoots]
    };
}

/**
 * Reveal the existing editor-tab panel, or create a new one. The new
 * panel attempts to restore the prior active target before falling
 * back to the placeholder welcome content; subsequent `nav` messages
 * or QuickPick selections drive page loads through the loader.
 *
 * Per docs/06-gotchas.md #18, we use the active editor's column on first
 * creation (falling back to `Beside`) and let `reveal()` keep the
 * column on subsequent invocations.
 *
 * `preserveFocus` defaults to `false` (the panel becomes active) — set
 * `true` from cursor-follow / hover paths so opening the surface never
 * steals keyboard focus from the editor mid-typing.
 */
export async function createOrRevealPanel(
    deps: PanelDeps,
    options: { preserveFocus?: boolean } = {}
): Promise<vscode.WebviewPanel> {
    const preserveFocus = options.preserveFocus ?? false;
    const existing = deps.manager.getPanel();
    if (existing) {
        existing.reveal(undefined, preserveFocus);
        return existing;
    }

    const column =
        vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    const panel = vscode.window.createWebviewPanel(
        PANEL_VIEW_TYPE,
        PANEL_TITLE,
        { viewColumn: column, preserveFocus },
        {
            ...panelWebviewOptions(deps),
            retainContextWhenHidden: false
        }
    );
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'cpp-docset-library.svg');

    const history = attachPanel(panel, deps);

    // Set HTML synchronously before the first `await` so VS Code's CSP
    // check (which fires when the panel is created with enableScripts)
    // always finds a valid meta CSP tag. Replaced below if history exists.
    const ctx: SharedRenderContext = {
        webview: panel.webview,
        bootstrapUri: deps.bootstrapUri,
        respectVSCodeTheme: deps.respectVSCodeTheme?.() ?? true,
        zoomLevel: deps.zoomLevel?.() ?? 1.0,
        codeTheme: deps.codeTheme?.(),
        surfaceKind: 'panel',
        ...(deps.controls ? { controls: deps.controls() } : {})
    };
    panel.webview.html = renderPlaceholder(ctx, {
        attribution: { pagePath: 'cpp', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        noDocsets: !deps.docsets.hasAnyDocset()
    });

    // Fix A — restore prior active target if we had one when the panel
    // was last disposed. Placeholder stays when no history exists or the
    // saved page no longer resolves.
    const target = history.current();
    if (target) {
        const ok = await loadPageInWebview(
            panel.webview,
            deps.bootstrapUri,
            target,
            { ...deps, surfaceKind: 'panel' }
        );
        if (ok) deps.manager.notifyNavigated(target);
    }

    return panel;
}

/**
 * Re-attach a panel that VSCode revived from a serialized state, then
 * either re-render the saved page (if any) or fall back to the
 * placeholder. Used by `DocPanelSerializer.deserializeWebviewPanel`.
 *
 * Fix A — the manager's panelHistory takes precedence over the
 * serialized blob when present. Practically the serializer fires on
 * cold-start (manager has no history yet), so the two paths rarely
 * collide; when they do, the manager's history is the more recent
 * truth.
 */
export async function rehydratePanel(
    panel: vscode.WebviewPanel,
    state: { active?: { docsetId: number; pagePath: string; scrollY?: number } } | undefined,
    deps: PanelDeps
): Promise<void> {
    panel.webview.options = panelWebviewOptions(deps);
    panel.iconPath = vscode.Uri.joinPath(deps.extensionUri, 'media', 'cpp-docset-library.svg');
    const history = attachPanel(panel, deps);

    // Set HTML synchronously before the first `await` (same CSP-timing fix
    // as createOrRevealPanel). Replaced below if saved state can be restored.
    const ctx: SharedRenderContext = {
        webview: panel.webview,
        bootstrapUri: deps.bootstrapUri,
        respectVSCodeTheme: deps.respectVSCodeTheme?.() ?? true,
        zoomLevel: deps.zoomLevel?.() ?? 1.0,
        codeTheme: deps.codeTheme?.(),
        surfaceKind: 'panel',
        ...(deps.controls ? { controls: deps.controls() } : {})
    };
    panel.webview.html = renderPlaceholder(ctx, {
        attribution: { pagePath: 'cpp', enabled: deps.attributionEnabled() },
        cppStandard: deps.cppStandard.current().token,
        noDocsets: !deps.docsets.hasAnyDocset()
    });

    // Prefer the manager's retained history (a panel re-resolve mid-
    // session), falling back to the serialized blob (cold-start revival).
    // Placeholder stays if saved page no longer resolves.
    const target = history.current() ?? state?.active;
    if (target) {
        if (history.current() === undefined) history.push(target);
        const ok = await loadPageInWebview(
            panel.webview,
            deps.bootstrapUri,
            target,
            { ...deps, surfaceKind: 'panel' }
        );
        if (ok) deps.manager.notifyNavigated(target);
    }
}
